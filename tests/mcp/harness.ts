import { randomBytes } from "node:crypto";
import { vi, type Mock } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { booking, bookingService, client, messageLog, payment } from "@/db/schema";
import type { McpServices, McpDeps } from "@/server/mcp/deps";
import { loadMcpConfig, type McpConfig } from "@/server/mcp/config";
import { createRateLimiter } from "@/server/mcp/rate-limit";
import { createMcpServer } from "@/server/mcp/server";
import type { McpPrincipal } from "@/server/mcp/auth";
import type { ToolDef } from "@/server/mcp/deps";
import type { AvailableSlot } from "@/server/contracts";
import { createTestDb } from "../helpers/test-db";
import { NOW, seedReportFixture, type Fixture } from "../reports/fixture";
import "../reports/timeouts";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

export const SECRET = randomBytes(32).toString("base64");

export type FakeServices = { [K in keyof McpServices]: Mock<McpServices[K]> };

/** Domain fakes that make the same kind of DB change the real functions will, so flows can be checked end to end. */
export function createFakeServices(
  getDb: () => TestDb["db"],
  slots: () => AvailableSlot[],
): FakeServices {
  const db = () => getDb();
  return {
    getAvailableSlots: vi.fn(async () => slots()),
    createHold: vi.fn(async (_db, input) => {
      const [existing] = await db()
        .select()
        .from(client)
        .where(eq(client.email, input.client.email ?? ""));
      const [c] = existing
        ? [existing]
        : await db()
            .insert(client)
            .values({
              firstName: input.client.firstName,
              lastName: input.client.lastName,
              email: input.client.email,
              phone: input.client.phone,
            })
            .returning();
      const during = { start: input.start, end: new Date(input.start.getTime() + 45 * 60_000) };
      const [b] = await db()
        .insert(booking)
        .values({
          staffId: input.staffId ?? (await db().query.staff.findFirst())!.id,
          locationId: input.locationId,
          clientId: c.id,
          status: "pending_payment",
          during,
          totalCents: 9500,
          depositCents: 4750,
          comments: input.comments,
          source: input.source ?? "online",
        })
        .returning();
      await db().insert(bookingService).values({
        bookingId: b.id,
        serviceId: input.serviceIds[0],
        name: "Cut",
        durationMin: 45,
        priceCents: 9500,
      });
      return {
        bookingId: b.id,
        manageToken: "t",
        holdExpiresAt: new Date(NOW.getTime() + 600_000),
        totalCents: 9500,
        depositCents: 4750,
        during,
      };
    }),
    confirmBooking: vi.fn(async (_db, bookingId) => {
      await db().update(booking).set({ status: "confirmed" }).where(eq(booking.id, bookingId));
    }),
    cancelBooking: vi.fn(async (_db, input) => {
      await db()
        .update(booking)
        .set({ status: "cancelled_by_staff", cancelReason: input.reason })
        .where(eq(booking.id, input.bookingId));
      return {
        bookingId: input.bookingId,
        status: "cancelled_by_staff" as const,
        depositAction: input.forceRefund ? ("refund" as const) : ("keep" as const),
        feeCents: 0,
      };
    }),
    rescheduleBooking: vi.fn(async (_db, input) => {
      await db()
        .update(booking)
        .set({
          during: { start: input.newStart, end: new Date(input.newStart.getTime() + 45 * 60_000) },
        })
        .where(eq(booking.id, input.bookingId));
    }),
    refundPayment: vi.fn(async (_db, paymentId, amountCents) => {
      const [p] = await db().select().from(payment).where(eq(payment.id, paymentId));
      await db()
        .insert(payment)
        .values({
          bookingId: p.bookingId,
          kind: "refund",
          method: p.method,
          status: "succeeded",
          amountCents: amountCents ?? p.amountCents,
        });
    }),
    chargeSavedCard: vi.fn(async (_db, input) => {
      await db().insert(payment).values({
        bookingId: input.bookingId,
        kind: input.kind,
        method: "stripe_online",
        status: "succeeded",
        amountCents: input.amountCents,
      });
    }),
    sendOneOffMessage: vi.fn(async (_db, input) => {
      await db().insert(messageLog).values({
        clientId: input.clientId,
        channel: input.channel,
        template: "one_off",
        toAddress: "x",
        status: "sent",
      });
    }),
  };
}

export interface Harness {
  t: TestDb;
  fx: Fixture;
  deps: McpDeps;
  services: FakeServices;
  clock: { now: Date };
  config: McpConfig;
  setSlots(slots: AvailableSlot[]): void;
  connect(options?: {
    principal?: McpPrincipal;
    tools?: readonly ToolDef[];
    /** Override parts of the dependencies for this connection only (e.g. a tighter rate limiter). */
    deps?: Partial<McpDeps>;
  }): Promise<{
    client: Client;
    call: (name: string, args?: Record<string, unknown>) => Promise<Result>;
    close: () => Promise<void>;
  }>;
  close(): Promise<void>;
}

export interface Result {
  isError: boolean;
  /** Parsed JSON body (error bodies look like { error: { code, message } }). */
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  raw: string;
}

export async function createHarness(
  env: Record<string, string | undefined> = {},
): Promise<Harness> {
  const t = await createTestDb();
  const fx = await seedReportFixture(t.db);
  // Give a client a phone and another a saved card, so messaging and fees have something to work with.
  await t.db.update(client).set({ phone: "+61410123456" }).where(eq(client.id, fx.clients.sam));
  await t.db
    .update(client)
    .set({ stripeCustomerId: "cus_test", phone: "+61411222333" })
    .where(eq(client.id, fx.clients.alex));

  let slots: AvailableSlot[] = [];
  const services = createFakeServices(
    () => t.db,
    () => slots,
  );
  const clock = { now: NOW };
  const config = loadMcpConfig({
    MCP_RATE_LIMIT_PER_MIN: "1000",
    MCP_WRITE_RATE_LIMIT_PER_MIN: "1000",
    ...env,
  });
  const deps: McpDeps = {
    db: t.db,
    services,
    config,
    getConfirmSecret: () => SECRET,
    now: () => clock.now,
    writeLimiter: createRateLimiter({
      limit: config.writesPerMinute,
      windowMs: 60_000,
      now: () => clock.now,
    }),
  };
  const principal: McpPrincipal = { actor: "mcp", ownerId: "owner-1", tokenId: "tok1" };

  const harness: Harness = {
    t,
    fx,
    deps,
    services,
    clock,
    config,
    setSlots(next) {
      slots = next;
    },
    async connect(options = {}) {
      const server = createMcpServer(
        { ...deps, ...options.deps },
        options.principal ?? principal,
        options.tools,
      );
      const mcpClient = new Client({ name: "test", version: "0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), mcpClient.connect(clientSide)]);
      return {
        client: mcpClient,
        async call(name, args = {}) {
          const res = (await mcpClient.callTool({ name, arguments: args })) as {
            isError?: boolean;
            content: Array<{ type: string; text: string }>;
          };
          const raw = res.content[0].text;
          return { isError: Boolean(res.isError), body: JSON.parse(raw), raw };
        },
        async close() {
          await mcpClient.close();
          await server.close();
        },
      };
    },
    async close() {
      await t.client.close();
    },
  };
  return harness;
}
