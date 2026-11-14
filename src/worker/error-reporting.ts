import type { PgBoss } from "pg-boss";

export type ReportJobError = (error: unknown, queue: string) => void;

type Handler = (jobs: unknown) => Promise<unknown>;

/**
 * Wraps `boss.work` so a throwing job handler is reported (to Sentry) before pg-boss retries it.
 * Everything else on the boss passes through untouched. The error is always rethrown, so retry and
 * backoff behave exactly as before.
 */
export function withJobErrorReporting(boss: PgBoss, report: ReportJobError): PgBoss {
  return new Proxy(boss, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "work") {
        return (name: string, ...args: unknown[]) => {
          const last = args.length - 1;
          const handler = args[last] as Handler;
          args[last] = async (jobs: unknown) => {
            try {
              return await handler(jobs);
            } catch (error) {
              report(error, name);
              throw error;
            }
          };
          return (value as (...a: unknown[]) => unknown).call(target, name, ...args);
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
