import type { z } from "zod";
import type { Db } from "../db-types";
import type { AvailabilityQuery, AvailableSlot } from "../contracts";
import type {
  CancelInput,
  CancelOutcome,
  CreateHoldInput,
  HoldResult,
  RescheduleInput,
} from "../contracts";
import { getAvailableSlots } from "../availability";
import { cancelBooking, confirmBooking, createHold, rescheduleBooking } from "../booking";
import { chargeSavedCard, refundPayment } from "../payments";
import { sendOneOffMessage } from "../notifications";
import type { McpPrincipal } from "./auth";
import type { McpConfig } from "./config";
import type { RateLimiter } from "./rate-limit";

/** The domain functions MCP write tools call. Injected so tests use fakes and the real ones arrive at merge. */
export interface McpServices {
  getAvailableSlots(db: Db, query: AvailabilityQuery): Promise<AvailableSlot[]>;
  createHold(db: Db, input: CreateHoldInput): Promise<HoldResult>;
  confirmBooking(db: Db, bookingId: string, now?: Date): Promise<void>;
  cancelBooking(db: Db, input: CancelInput): Promise<CancelOutcome>;
  rescheduleBooking(db: Db, input: RescheduleInput): Promise<void>;
  refundPayment(db: Db, paymentId: string, amountCents?: number): Promise<void>;
  chargeSavedCard(
    db: Db,
    input: { bookingId: string; kind: "no_show_fee" | "late_cancel_fee"; amountCents: number },
  ): Promise<void>;
  sendOneOffMessage(
    db: Db,
    input: { clientId: string; channel: "email" | "sms"; subject?: string; body: string },
  ): Promise<void>;
}

export const realServices: McpServices = {
  getAvailableSlots,
  createHold,
  confirmBooking,
  cancelBooking,
  rescheduleBooking,
  refundPayment,
  chargeSavedCard,
  sendOneOffMessage,
};

export interface McpDeps {
  db: Db;
  services: McpServices;
  config: McpConfig;
  /** base64 ENCRYPTION_KEY, read lazily so a missing key only fails the write tools that need it. */
  getConfirmSecret: () => string;
  now: () => Date;
  /** Limits write and money tool calls per token. */
  writeLimiter: RateLimiter;
}

export interface ToolContext {
  deps: McpDeps;
  principal: McpPrincipal;
  timezone: string;
  businessId: string;
}

/** A tool that only reads. No confirmation. */
export interface ReadToolDef<S extends z.ZodType = z.ZodType> {
  kind: "read";
  name: string;
  title: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

/** What a write tool says it is about to do, produced before anything changes. */
export interface Preview {
  /** One human-readable sentence or two. Any client text inside is quoted. */
  summary: string;
  /** Structured facts for the model. Client text is wrapped as untrusted. */
  details: Record<string, unknown>;
  /** Present on money tools: the exact amount that would move. */
  moneyCents?: number;
}

export interface Execution {
  summary: string;
  result: Record<string, unknown>;
  entityId?: string;
  /** Extra non-sensitive facts to keep in the audit row. */
  audit?: Record<string, unknown>;
}

/** A tool that changes things: preview first, then execute with the confirm token. */
export interface WriteToolDef<S extends z.ZodType = z.ZodType> {
  kind: "write" | "money";
  name: string;
  title: string;
  description: string;
  schema: S;
  destructive: boolean;
  entityType: string;
  /** Validate preconditions and describe the change. Runs on both steps, and must not change anything. */
  prepare(args: z.infer<S>, ctx: ToolContext): Promise<Preview>;
  execute(args: z.infer<S>, ctx: ToolContext, preview: Preview): Promise<Execution>;
  /** Arguments safe to store in the audit row (no message bodies). */
  auditArgs?(args: z.infer<S>): Record<string, unknown>;
}

export type ToolDef = ReadToolDef | WriteToolDef;

/** Register a read tool in the heterogeneous registry, keeping its argument types checked at the definition. */
export function defineRead<S extends z.ZodType>(def: ReadToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function defineWrite<S extends z.ZodType>(def: WriteToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}
