import { describe, expect, test, vi } from "vitest";
import { JOBS, handleHeartbeat } from "@/worker/jobs";

describe("worker jobs", () => {
  test("exposes stable queue names", () => {
    expect(JOBS.heartbeat).toBe("system.heartbeat");
  });

  test("heartbeat handler logs one structured line and resolves", async () => {
    const log = vi.fn();
    await handleHeartbeat({ log, now: () => new Date("2026-11-14T00:00:00Z") });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      event: "heartbeat",
      at: "2026-11-14T00:00:00.000Z",
    });
  });
});
