export type LogFn = (entry: Record<string, unknown>) => void;

/** Structured JSON-lines logger (Railway and most log tools parse this natively). */
export function createLogger(
  service: string,
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
  now: () => Date = () => new Date(),
): LogFn {
  return (entry) => {
    write(`${JSON.stringify({ service, time: now().toISOString(), ...entry })}\n`);
  };
}
