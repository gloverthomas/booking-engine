import { existsSync } from "node:fs";
import { closeDb, getDb } from "@/db/client";
import { seedDatabase } from "@/server/admin-foundation/seed";

/**
 * Idempotent seed: creates Ryan Kennedy Hairdressing, both locations, Ryan, the five services and sample hours
 * if they are missing. Safe to re-run; it never overwrites edits. Usage: `pnpm db:seed` (after `pnpm db:migrate`).
 */
async function main(): Promise<void> {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
  const result = await seedDatabase(getDb());
  process.stdout.write(
    `${JSON.stringify({ service: "seed", event: "seed_complete", ...result })}\n`,
  );
  await closeDb();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${JSON.stringify({ service: "seed", event: "fatal", message })}\n`);
  process.exit(1);
});
