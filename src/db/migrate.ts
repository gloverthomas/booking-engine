import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "./client";

/** Applies pending SQL migrations from ./drizzle. Run before each deploy (Railway pre-deploy command). */
async function main(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  process.stdout.write('{"service":"migrate","event":"migrations_applied"}\n');
  await closeDb();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${JSON.stringify({ service: "migrate", event: "fatal", message })}\n`);
  process.exit(1);
});
