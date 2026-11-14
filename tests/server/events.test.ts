import { describe, expect, test, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { domainEvent } from "@/db/schema";
import { EVENT_CONSUMERS, emitDomainEvent, relayDomainEvents } from "@/server/events";

describe("domain event outbox", () => {
  test("emit stores the event; relay fans it out to every consumer once and marks it processed", async () => {
    const { db, client } = await createTestDb();
    await emitDomainEvent(db, { type: "booking.confirmed", bookingId: "b1" });
    const publish = vi.fn(async () => {});

    expect(await relayDomainEvents(db, publish)).toBe(1);
    expect(publish).toHaveBeenCalledTimes(EVENT_CONSUMERS.length);
    expect(publish).toHaveBeenCalledWith(
      EVENT_CONSUMERS[0],
      expect.objectContaining({ type: "booking.confirmed", bookingId: "b1" }),
    );

    expect(await relayDomainEvents(db, publish)).toBe(0);
    const [row] = await db.select().from(domainEvent);
    expect(row.processedAt).not.toBeNull();
    await client.close();
  });

  test("a failed publish leaves the event unprocessed so it is retried", async () => {
    const { db, client } = await createTestDb();
    await emitDomainEvent(db, { type: "booking.completed", bookingId: "b2" });
    await expect(
      relayDomainEvents(db, async () => {
        throw new Error("queue down");
      }),
    ).rejects.toThrow("queue down");
    const [row] = await db.select().from(domainEvent);
    expect(row.processedAt).toBeNull();
    await client.close();
  });
});
