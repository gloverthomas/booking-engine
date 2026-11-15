import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { booking, integrationAccount, staff, timeBlock } from "@/db/schema";
import type { Permission } from "@/server/auth/permissions";
import type { StaffRole } from "@/server/contracts";
import {
  getAccount,
  listAccounts,
  markDisconnected,
  recordFailure,
  recordSuccess,
  saveConnection,
} from "@/server/integrations/common/account-store";
import { AuthRevokedError, ProviderNotFoundError } from "@/server/integrations/common/errors";
import { getStaffCalendarStatuses } from "@/server/integrations/common/status";
import { mayManageCalendar, permissionToReach } from "@/server/integrations/google/access";
import { deriveChannelToken, ensureWatchChannel } from "@/server/integrations/google/channel";
import { syncAllGoogleAccounts, syncGoogleCalendar } from "@/server/integrations/google/inbound";
import {
  runChannelRenewalJob,
  runGoogleReconcile,
  runGoogleSyncJob,
} from "@/server/integrations/google/jobs";
import { handleGoogleDomainEvent } from "@/server/integrations/google/outbound";
import { deterministicEventId } from "@/server/integrations/google/event-mapper";
import type { GoogleAuthPort, GoogleTokens } from "@/server/integrations/google/port";
import {
  googleCallback,
  googleConnect,
  googleDisconnect,
  googleWebhook,
  type GoogleRouteDeps,
} from "@/server/integrations/google/routes";
import type { GoogleAccessSession } from "@/server/integrations/google/access";
import type { GoogleDeps } from "@/server/integrations/google/runtime";
import { createStaff } from "../../helpers/factories";
import {
  busyEvent,
  fakeGoogle,
  fixedNow,
  seedAccount,
  seedBooking,
  setupTestDb,
  silentLog,
  testEnv,
  TEST_KEY,
  type BookingSeed,
  type FakeGoogle,
} from "../helpers";

const shared = setupTestDb();

/** Each account's tokens carry a label, so the test can hand every account its own fake calendar. */
const tokensFor = (label: string): GoogleTokens => ({
  accessToken: label,
  refreshToken: `r-${label}`,
  expiryDate: Date.parse("2027-01-01T00:00:00Z"),
});

describe("Google Calendar per stylist", () => {
  let t: (typeof shared)["current"];
  let seed: BookingSeed;
  let alexId: string;
  let businessWide: FakeGoogle;
  let ryanOwn: FakeGoogle;
  let alexOwn: FakeGoogle;
  let ports: Record<string, FakeGoogle>;
  let deps: GoogleDeps;

  beforeEach(async () => {
    t = shared.current;
    seed = await seedBooking(t.db);
    const alex = await createStaff(t.db, seed.businessId, { name: "Alex" });
    alexId = alex.id;
    businessWide = fakeGoogle();
    ryanOwn = fakeGoogle();
    alexOwn = fakeGoogle();
    ports = { shared: businessWide, ryan: ryanOwn, alex: alexOwn };
    deps = {
      db: t.db,
      env: testEnv(),
      now: fixedNow,
      log: silentLog,
      createPort: async ({ tokens }) => ports[tokens.accessToken ?? ""],
    };
  });

  const connectShared = () => seedAccount(t.db, seed.businessId, "google", {}, tokensFor("shared"));
  const connectRyan = () =>
    seedAccount(
      t.db,
      seed.businessId,
      "google",
      {
        staffId: seed.staffId,
        externalAccountId: "ryan@x.com",
        syncState: { calendarId: "ryan@x.com" },
      },
      tokensFor("ryan"),
    );
  const connectAlex = () =>
    seedAccount(
      t.db,
      seed.businessId,
      "google",
      { staffId: alexId, externalAccountId: "alex@x.com", syncState: { calendarId: "alex@x.com" } },
      tokensFor("alex"),
    );
  const moveBookingTo = (staffId: string) =>
    t.db.update(booking).set({ staffId }).where(eq(booking.id, seed.bookingId));
  const gcalId = async () =>
    (await t.db.select().from(booking).where(eq(booking.id, seed.bookingId)))[0].gcalEventId;
  const confirm = () =>
    handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });

  describe("account addressing", () => {
    test("(provider, null) and (provider, staffId) are different accounts and coexist", async () => {
      await connectShared();
      await connectRyan();
      await connectAlex();

      expect((await getAccount(t.db, "google"))?.staffId).toBeNull();
      expect((await getAccount(t.db, "google", seed.staffId))?.externalAccountId).toBe(
        "ryan@x.com",
      );
      expect((await getAccount(t.db, "google", alexId))?.externalAccountId).toBe("alex@x.com");
      expect(await getAccount(t.db, "xero")).toBeNull();
      const all = await listAccounts(t.db, "google");
      expect(all).toHaveLength(3);
      expect(all[0].staffId).toBeNull(); // business-wide first
    });

    test("saveConnection upserts per stylist without touching the business-wide account", async () => {
      const shared1 = await saveConnection(t.db, {
        provider: "google",
        externalAccountId: "primary",
        tokens: tokensFor("shared"),
        key: TEST_KEY,
        syncState: { calendarId: "primary" },
      });
      const first = await saveConnection(t.db, {
        provider: "google",
        staffId: alexId,
        externalAccountId: "alex@x.com",
        tokens: tokensFor("alex"),
        key: TEST_KEY,
        syncState: { calendarId: "alex@x.com" },
      });
      const again = await saveConnection(t.db, {
        provider: "google",
        staffId: alexId,
        externalAccountId: "alex2@x.com",
        tokens: tokensFor("alex"),
        key: TEST_KEY,
        syncState: { calendarId: "alex2@x.com" },
      });
      expect(again.id).toBe(first.id); // replaced in place, not duplicated
      expect(again.externalAccountId).toBe("alex2@x.com");
      expect(await t.db.select().from(integrationAccount)).toHaveLength(2);
      expect((await getAccount(t.db, "google"))?.id).toBe(shared1.id);
    });

    test("failure, success and disconnect touch only the addressed account", async () => {
      await connectShared();
      await connectRyan();
      await connectAlex();

      await recordFailure(t.db, "google", "bad", { fatal: true, staffId: alexId });
      let rows = await listAccounts(t.db, "google");
      expect(rows.map((r) => [r.staffId === alexId, r.status, r.lastError])).toEqual([
        [false, "connected", null],
        [false, "connected", null],
        [true, "error", "bad"],
      ]);

      await recordSuccess(t.db, "google", fixedNow(), alexId);
      await markDisconnected(t.db, "google", { staffId: alexId });
      rows = await listAccounts(t.db, "google");
      expect(rows.filter((r) => r.status === "disconnected")).toHaveLength(1);
      expect(rows.find((r) => r.staffId === alexId)?.encryptedTokens).toBeNull();
      expect(rows.filter((r) => r.encryptedTokens !== null)).toHaveLength(2);

      // The default scope is the business-wide account only.
      await recordFailure(t.db, "google", "shared down", { fatal: false });
      rows = await listAccounts(t.db, "google");
      expect(rows.filter((r) => r.lastError === "shared down").map((r) => r.staffId)).toEqual([
        null,
      ]);
    });

    test("status lists each stylist's own calendar with their name", async () => {
      await connectShared();
      await connectAlex();
      const statuses = await getStaffCalendarStatuses(t.db);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({
        staffId: alexId,
        staffName: "Alex",
        status: "connected",
        target: "alex@x.com",
      });
    });
  });

  describe("outbound routing", () => {
    test("goes to the booking stylist's own calendar, not the shared one", async () => {
      await connectShared();
      await connectRyan();
      await confirm();
      expect(ryanOwn.calls.map((c) => c.method)).toEqual(["insert"]);
      expect(ryanOwn.calls[0].args[0]).toBe("ryan@x.com");
      expect(businessWide.calls).toHaveLength(0);
      expect(await gcalId()).toBe(deterministicEventId(seed.bookingId));
    });

    test("falls back to the business-wide calendar when the stylist has none", async () => {
      await connectShared();
      await connectAlex(); // someone else's own calendar is irrelevant
      await confirm();
      expect(businessWide.calls.map((c) => c.method)).toEqual(["insert"]);
      expect(alexOwn.calls).toHaveLength(0);
    });

    test("does nothing when neither the stylist nor the business has a calendar", async () => {
      await connectAlex();
      await confirm();
      expect(alexOwn.calls).toHaveLength(0);
      expect(businessWide.calls).toHaveLength(0);
      expect(await gcalId()).toBeNull();
    });

    test("a stylist whose own account has errored falls back to the shared calendar", async () => {
      await connectShared();
      await connectRyan();
      await recordFailure(t.db, "google", "x", { fatal: true, staffId: seed.staffId });
      await confirm();
      expect(businessWide.calls.map((c) => c.method)).toEqual(["insert"]);
      expect(ryanOwn.calls).toHaveLength(0);
    });

    test("reassigning to another stylist moves the event between calendars", async () => {
      await connectRyan();
      await connectAlex();
      await confirm();
      await moveBookingTo(alexId);
      alexOwn.patchError = new ProviderNotFoundError("not in Alex's calendar yet");
      await handleGoogleDomainEvent(deps, {
        type: "booking.rescheduled",
        bookingId: seed.bookingId,
      });

      // Alex's calendar gains the event (patch is missing there, so it is created)...
      expect(alexOwn.calls.map((c) => c.method)).toEqual(["patch", "insert"]);
      // ...and Ryan's loses it.
      expect(ryanOwn.calls.map((c) => c.method)).toEqual(["insert", "delete"]);
      expect(await gcalId()).toBe(deterministicEventId(seed.bookingId));
    });

    test("reassigning to a stylist with no calendar (and no shared one) clears the old event", async () => {
      await connectRyan();
      await confirm();
      const bob = await createStaff(t.db, seed.businessId, { name: "Bob", email: "bob@x.com" });
      await moveBookingTo(bob.id);
      await handleGoogleDomainEvent(deps, {
        type: "booking.rescheduled",
        bookingId: seed.bookingId,
      });
      expect(ryanOwn.calls.map((c) => c.method)).toEqual(["insert", "delete"]);
      expect(await gcalId()).toBeNull();
    });

    test("a plain time change never touches other calendars beyond a harmless delete", async () => {
      await connectRyan();
      await connectAlex();
      await confirm();
      alexOwn.deleteError = new ProviderNotFoundError("not here");
      await handleGoogleDomainEvent(deps, {
        type: "booking.rescheduled",
        bookingId: seed.bookingId,
      });
      expect(ryanOwn.calls.map((c) => c.method)).toEqual(["insert", "patch"]);
      expect((await getAccount(t.db, "google", alexId))?.status).toBe("connected");
      expect((await getAccount(t.db, "google", alexId))?.lastError).toBeNull();
    });

    test("cancelling removes the event from whichever calendar holds it", async () => {
      await connectShared();
      await confirm(); // lands in the shared calendar
      await connectRyan(); // Ryan connects afterwards
      await handleGoogleDomainEvent(deps, { type: "booking.cancelled", bookingId: seed.bookingId });
      expect(businessWide.calls.map((c) => c.method)).toEqual(["insert", "delete"]);
      expect(await gcalId()).toBeNull();
    });

    test("a revoked token marks only that stylist's account as error", async () => {
      await connectShared();
      await connectRyan();
      await connectAlex();
      ryanOwn.insertError = new AuthRevokedError("invalid_grant");
      await expect(confirm()).resolves.toBeUndefined();

      const byStaff = new Map((await listAccounts(t.db, "google")).map((r) => [r.staffId, r]));
      expect(byStaff.get(seed.staffId)?.status).toBe("error");
      expect(byStaff.get(alexId)?.status).toBe("connected");
      expect(byStaff.get(null)?.status).toBe("connected");
      expect(byStaff.get(null)?.lastError).toBeNull();
    });

    test("a transient failure on one calendar is retried but does not poison another's status", async () => {
      await connectRyan();
      await connectAlex();
      await confirm();
      await moveBookingTo(alexId);
      ryanOwn.deleteError = new Error("boom");
      await expect(
        handleGoogleDomainEvent(deps, { type: "booking.rescheduled", bookingId: seed.bookingId }),
      ).rejects.toThrow("boom");
      expect((await getAccount(t.db, "google", alexId))?.lastError).toBeNull();
      expect((await getAccount(t.db, "google", seed.staffId))?.lastError).toBe("boom");
    });
  });

  describe("inbound sync writes blocks for the right person", () => {
    test("each stylist's own account blocks that stylist only", async () => {
      await connectRyan();
      await connectAlex();
      ryanOwn.listResponses.push({
        events: [busyEvent("r1", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
        nextSyncToken: "t-r",
      });
      alexOwn.listResponses.push({
        events: [busyEvent("a1", "2026-11-20T03:00:00Z", "2026-11-20T04:00:00Z")],
        nextSyncToken: "t-a",
      });

      await syncAllGoogleAccounts(deps);

      const rows = await t.db.select().from(timeBlock);
      expect(
        rows.map((r) => [r.externalId, r.staffId === alexId ? "alex" : "ryan"]).sort(),
      ).toEqual([
        ["a1", "alex"],
        ["r1", "ryan"],
      ]);
    });

    test("a full sync of one stylist never deletes another stylist's blocks", async () => {
      await connectRyan();
      await connectAlex();
      ryanOwn.listResponses.push({
        events: [busyEvent("same-id", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
      });
      alexOwn.listResponses.push({
        events: [busyEvent("same-id", "2026-11-20T03:00:00Z", "2026-11-20T04:00:00Z")],
      });
      await syncGoogleCalendar(deps, { staffId: seed.staffId });
      await syncGoogleCalendar(deps, { staffId: alexId });
      // Alex's calendar later returns nothing: only Alex's block goes.
      alexOwn.listResponses.push({ events: [] });
      await syncGoogleCalendar(deps, { staffId: alexId, forceFull: true });

      const rows = await t.db.select().from(timeBlock);
      expect(rows.map((r) => r.staffId)).toEqual([seed.staffId]);
    });

    test("the business-wide account blocks its configured stylist", async () => {
      await connectShared();
      await t.db
        .update(integrationAccount)
        .set({ syncState: { calendarId: "primary", staffId: alexId } });
      businessWide.listResponses.push({
        events: [busyEvent("s1", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
      });
      await syncGoogleCalendar(deps);
      expect((await t.db.select().from(timeBlock)).map((r) => r.staffId)).toEqual([alexId]);
    });

    test("the business-wide account stands down for a stylist who has their own calendar", async () => {
      await connectShared(); // would feed the first active stylist, Ryan
      await connectRyan();
      const result = await syncGoogleCalendar(deps);
      expect(result.mode).toBe("skipped");
      expect(businessWide.listParams).toHaveLength(0);
    });

    test("syncAllGoogleAccounts isolates failures and rethrows the first afterwards", async () => {
      await connectRyan();
      await connectAlex();
      ryanOwn.listResponses.push(new Error("ryan sync broke"));
      alexOwn.listResponses.push({
        events: [busyEvent("a1", "2026-11-20T03:00:00Z", "2026-11-20T04:00:00Z")],
      });
      await expect(syncAllGoogleAccounts(deps)).rejects.toThrow("ryan sync broke");
      expect((await t.db.select().from(timeBlock)).map((r) => r.externalId)).toEqual(["a1"]);
    });

    test("a revoked stylist account is flagged alone while the others keep syncing", async () => {
      await connectRyan();
      await connectAlex();
      ryanOwn.listResponses.push(new AuthRevokedError("revoked"));
      const outcomes = await syncAllGoogleAccounts(deps);
      expect(outcomes).toHaveLength(2);
      expect((await getAccount(t.db, "google", seed.staffId))?.status).toBe("error");
      expect((await getAccount(t.db, "google", alexId))?.status).toBe("connected");
    });
  });

  describe("channels, webhook, jobs", () => {
    test("each account gets its own channel and a push syncs only that account", async () => {
      await connectRyan();
      await connectAlex();
      await ensureWatchChannel(deps, { staffId: seed.staffId });
      await ensureWatchChannel(deps, { staffId: alexId });
      expect(ryanOwn.watches).toHaveLength(1);
      expect(alexOwn.watches).toHaveLength(1);

      const route = routeDeps();
      const channelId = alexOwn.watches[0].channelId;
      const res = await googleWebhook(
        new Request("https://x.test/hook", {
          method: "POST",
          headers: {
            "x-goog-channel-id": channelId,
            "x-goog-channel-token": deriveChannelToken(TEST_KEY, channelId),
            "x-goog-resource-state": "exists",
            "x-goog-message-number": "1",
          },
        }),
        route,
      );
      expect(res.status).toBe(200);
      await tasks.splice(0).at(0)?.();
      expect(alexOwn.listParams).toHaveLength(1);
      expect(ryanOwn.listParams).toHaveLength(0);
    });

    test("the poll and renewal jobs run per account", async () => {
      await connectShared();
      await connectRyan();
      await connectAlex();
      // Business-wide stands down for Ryan, so only the two personal accounts list events.
      await runGoogleSyncJob(deps);
      expect(ryanOwn.listParams).toHaveLength(1);
      expect(alexOwn.listParams).toHaveLength(1);
      expect(businessWide.listParams).toHaveLength(0);
      expect([businessWide, ryanOwn, alexOwn].map((g) => g.watches.length)).toEqual([1, 1, 1]);

      for (const g of [businessWide, ryanOwn, alexOwn]) g.watches.length = 0;
      await t.db.update(integrationAccount).set({ syncState: { calendarId: "x" } });
      await runChannelRenewalJob(deps);
      expect([businessWide, ryanOwn, alexOwn].map((g) => g.watches.length)).toEqual([1, 1, 1]);
    });

    test("reconcile only pushes bookings that can land somewhere", async () => {
      // Only Alex has a calendar; Ryan's booking has nowhere to go and must not be retried forever.
      await connectAlex();
      expect(await runGoogleReconcile(deps)).toBe(0);
      expect(alexOwn.calls).toHaveLength(0);

      await moveBookingTo(alexId);
      expect(await runGoogleReconcile(deps)).toBe(1);
      expect(alexOwn.calls.map((c) => c.method)).toEqual(["insert"]);
    });

    test("with a business-wide calendar every stylist's booking is reconciled", async () => {
      await connectShared();
      expect(await runGoogleReconcile(deps)).toBe(1);
      expect(businessWide.calls.map((c) => c.method)).toEqual(["insert"]);
    });
  });

  describe("routes: permission, state binding, isolation", () => {
    let requireAccess: ReturnType<
      typeof vi.fn<(permission: Permission) => Promise<GoogleAccessSession>>
    >;
    let session: GoogleAccessSession;
    let authPort: GoogleAuthPort;

    beforeEach(() => {
      session = { staffId: null, role: "owner" };
      requireAccess = vi.fn(async () => session);
      authPort = {
        buildAuthUrl: vi.fn(async ({ state }) => `https://accounts.google.com/auth?state=${state}`),
        exchangeCode: vi.fn(async (): Promise<GoogleTokens> => tokensFor("alex")),
      };
      tasks.length = 0;
    });

    const routes = (): GoogleRouteDeps => ({
      ...deps,
      requireAccess,
      authPort,
      runAfter: (task) => tasks.push(task),
    });
    const connect = async (qs: string) => {
      const res = await googleConnect(
        new Request(`https://book.example.com/api/integrations/google/connect${qs}`),
        routes(),
      );
      return {
        res,
        state: res.headers.get("location")
          ? new URL(res.headers.get("location")!).searchParams.get("state")!
          : "",
        cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "",
      };
    };
    const callback = (qs: string, cookie: string) =>
      googleCallback(
        new Request(`https://book.example.com/api/integrations/google/callback?${qs}`, {
          headers: { cookie },
        }),
        routes(),
      );

    test("pure permission rules", () => {
      const as = (role: StaffRole, staffId: string | null = null): GoogleAccessSession => ({
        role,
        staffId,
      });
      expect(permissionToReach(null)).toBe("integrations.manage");
      expect(permissionToReach(alexId)).toBe("calendar.viewOwn");
      expect(mayManageCalendar(as("owner"), null)).toBe(true);
      expect(mayManageCalendar(as("manager"), null)).toBe(false);
      expect(mayManageCalendar(as("owner"), alexId)).toBe(true);
      expect(mayManageCalendar(as("manager"), alexId)).toBe(true);
      expect(mayManageCalendar(as("stylist", alexId), alexId)).toBe(true);
      expect(mayManageCalendar(as("stylist", seed.staffId), alexId)).toBe(false);
      expect(mayManageCalendar(as("stylist", null), alexId)).toBe(false);
      expect(mayManageCalendar(as("reception", alexId), alexId)).toBe(false);
    });

    test("an owner connects a stylist's calendar: the state binds the staffId and tokens go to that stylist", async () => {
      const { res, state, cookie } = await connect(`?staffId=${alexId}&calendarId=alex%40x.com`);
      expect(requireAccess).toHaveBeenCalledWith("calendar.viewOwn");
      expect(res.status).toBe(302);

      // A staffId in the callback URL is ignored: only the encrypted cookie decides.
      const done = await callback(`code=c&state=${state}&staffId=${seed.staffId}`, cookie);
      expect(done.headers.get("location")).toContain("status=connected");

      const own = await getAccount(t.db, "google", alexId);
      expect(own?.externalAccountId).toBe("alex@x.com");
      expect(await getAccount(t.db, "google", seed.staffId)).toBeNull();
      expect(await getAccount(t.db, "google")).toBeNull();

      expect(tasks).toHaveLength(1);
      alexOwn.listResponses.push({ events: [], nextSyncToken: "t" });
      await tasks[0]();
      expect(alexOwn.listParams).toHaveLength(1);
      expect(alexOwn.watches).toHaveLength(1);
    });

    test("a stylist can connect their own calendar but not another stylist's", async () => {
      session = { staffId: alexId, role: "stylist" };
      const own = await connect(`?staffId=${alexId}`);
      expect(own.res.status).toBe(302);
      const other = await connect(`?staffId=${seed.staffId}`);
      expect(other.res.status).toBe(403);
      expect(other.res.headers.get("set-cookie")).toBeNull();
    });

    test("a stylist cannot connect the business-wide calendar; permission failures propagate", async () => {
      session = { staffId: alexId, role: "stylist" };
      expect((await connect("")).res.status).toBe(403);
      requireAccess.mockRejectedValueOnce(new Error("Not allowed: integrations.manage"));
      await expect(
        googleConnect(new Request("https://x.test/api/integrations/google/connect"), routes()),
      ).rejects.toThrow("Not allowed");
    });

    test("rejects an invalid or unknown staffId", async () => {
      expect((await connect("?staffId=not-a-uuid")).res.status).toBe(400);
      expect((await connect("?staffId=00000000-0000-4000-8000-000000000000")).res.status).toBe(404);
    });

    test("callback re-checks the permission against the bound stylist", async () => {
      session = { staffId: alexId, role: "stylist" };
      const { state, cookie } = await connect(`?staffId=${alexId}`);
      // The same browser session is now someone else (e.g. signed in as another stylist).
      session = { staffId: seed.staffId, role: "stylist" };
      const done = await callback(`code=c&state=${state}`, cookie);
      expect(done.headers.get("location")).toContain("status=error");
      expect(authPort.exchangeCode).not.toHaveBeenCalled();
      expect(await t.db.select().from(integrationAccount)).toHaveLength(0);
    });

    test("a forged state is rejected for a stylist connection too", async () => {
      const { cookie } = await connect(`?staffId=${alexId}`);
      const done = await callback("code=c&state=attacker", cookie);
      expect(done.headers.get("location")).toContain("status=error");
      expect(await t.db.select().from(integrationAccount)).toHaveLength(0);
    });

    test("disconnecting one stylist leaves the others, and their blocks, alone", async () => {
      await connectShared();
      await connectRyan();
      await connectAlex();
      const during = {
        start: new Date("2026-12-01T00:00:00Z"),
        end: new Date("2026-12-01T01:00:00Z"),
      };
      await t.db.insert(timeBlock).values([
        { staffId: alexId, during, source: "google", externalId: "a" },
        { staffId: seed.staffId, during, source: "google", externalId: "r" },
        { staffId: alexId, during, source: "manual" },
      ]);
      await ensureWatchChannel(deps, { staffId: alexId });

      const res = await googleDisconnect(
        new Request(`https://x.test/d?staffId=${alexId}`, { method: "POST" }),
        routes(),
      );
      expect(res.status).toBe(200);

      const rows = await listAccounts(t.db, "google");
      expect(rows.map((r) => [r.staffId === alexId, r.status])).toEqual([
        [false, "connected"],
        [false, "connected"],
        [true, "disconnected"],
      ]);
      expect(alexOwn.calls.some((c) => c.method === "stop")).toBe(true);
      expect(ryanOwn.calls.some((c) => c.method === "stop")).toBe(false);
      const blocks = await t.db.select().from(timeBlock);
      expect(
        blocks.map((b) => `${b.staffId === alexId ? "alex" : "ryan"}:${b.source}`).sort(),
      ).toEqual(["alex:manual", "ryan:google"]);
    });

    test("disconnecting the business-wide calendar leaves a stylist's own calendar and blocks", async () => {
      await connectShared();
      await connectRyan();
      const during = {
        start: new Date("2026-12-01T00:00:00Z"),
        end: new Date("2026-12-01T01:00:00Z"),
      };
      await t.db
        .insert(timeBlock)
        .values({ staffId: seed.staffId, during, source: "google", externalId: "r" });
      await googleDisconnect(new Request("https://x.test/d", { method: "POST" }), routes());
      expect((await getAccount(t.db, "google"))?.status).toBe("disconnected");
      expect((await getAccount(t.db, "google", seed.staffId))?.status).toBe("connected");
      expect(await t.db.select().from(timeBlock)).toHaveLength(1);
    });

    test("a stylist may disconnect only their own calendar", async () => {
      await connectRyan();
      session = { staffId: alexId, role: "stylist" };
      const res = await googleDisconnect(
        new Request(`https://x.test/d?staffId=${seed.staffId}`, { method: "POST" }),
        routes(),
      );
      expect(res.status).toBe(403);
      expect((await getAccount(t.db, "google", seed.staffId))?.status).toBe("connected");
    });

    test("an inactive stylist row does not matter to the account lookup", async () => {
      await t.db.update(staff).set({ active: false }).where(eq(staff.id, alexId));
      await connectAlex();
      expect((await getAccount(t.db, "google", alexId))?.status).toBe("connected");
    });
  });

  // Shared between the webhook test and the route helpers above.
  const tasks: Array<() => Promise<void>> = [];
  function routeDeps(): GoogleRouteDeps {
    return {
      ...deps,
      requireAccess: async () => ({ staffId: null, role: "owner" }),
      runAfter: (task) => tasks.push(task),
    };
  }
});
