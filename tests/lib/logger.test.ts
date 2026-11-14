import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@/lib/logger";

describe("createLogger", () => {
  test("writes one JSON line per entry including the service name and a timestamp", () => {
    const write = vi.fn();
    const log = createLogger("worker", write, () => new Date("2026-11-14T00:00:00Z"));
    log({ event: "hello", n: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0][0] as string;
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      service: "worker",
      time: "2026-11-14T00:00:00.000Z",
      event: "hello",
      n: 1,
    });
  });
});

describe("createLogger defaults", () => {
  test("writes to stdout and uses the real clock when no overrides are given", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    createLogger("web")({ event: "x" });
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.service).toBe("web");
    expect(Number.isNaN(Date.parse(parsed.time))).toBe(false);
    spy.mockRestore();
  });
});
