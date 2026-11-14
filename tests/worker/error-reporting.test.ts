import { describe, expect, test, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { withJobErrorReporting } from "@/worker/error-reporting";

function fakeBoss() {
  const registered: Array<{ name: string; handler: (jobs: unknown) => Promise<unknown> }> = [];
  const boss = {
    marker: "boss",
    work: vi.fn(async (name: string, ...args: unknown[]) => {
      registered.push({ name, handler: args[args.length - 1] as never });
      return "worker-id";
    }),
    send: vi.fn(async () => "job-id"),
  };
  return { boss: boss as unknown as PgBoss, raw: boss, registered };
}

describe("withJobErrorReporting", () => {
  test("reports a failing handler with its queue name and rethrows so pg-boss retries", async () => {
    const { boss, registered } = fakeBoss();
    const report = vi.fn();
    const wrapped = withJobErrorReporting(boss, report);

    await wrapped.work("consumer.xero", async () => {
      throw new Error("xero 503");
    });

    await expect(registered[0].handler([])).rejects.toThrow("xero 503");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1]).toBe("consumer.xero");
    expect((report.mock.calls[0][0] as Error).message).toBe("xero 503");
  });

  test("passes results through, supports the options overload, and does not report successes", async () => {
    const { boss, registered, raw } = fakeBoss();
    const report = vi.fn();
    const wrapped = withJobErrorReporting(boss, report);

    const id = await (
      wrapped.work as unknown as (n: string, o: object, h: () => Promise<string>) => Promise<string>
    )("q", { batchSize: 5 }, async () => "ok");

    expect(id).toBe("worker-id");
    expect(raw.work.mock.calls[0][1]).toEqual({ batchSize: 5 });
    expect(await registered[0].handler([])).toBe("ok");
    expect(report).not.toHaveBeenCalled();
  });

  test("other methods and properties pass straight through", async () => {
    const { boss, raw } = fakeBoss();
    const wrapped = withJobErrorReporting(boss, vi.fn());
    expect(await wrapped.send("q", {})).toBe("job-id");
    expect(raw.send).toHaveBeenCalledTimes(1);
    expect((wrapped as unknown as { marker: string }).marker).toBe("boss");
  });
});
