import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Never connects: DB tests use in-process Postgres. Lets getEnv() succeed in unit tests.
    env: { DATABASE_URL: "postgres://test:test@localhost:5432/test" },
    testTimeout: 30_000,
    // In-process Postgres (PGlite) starts slowly when many test files boot it in parallel.
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/db/**", "src/server/**", "src/worker/**"],
      exclude: [
        "src/db/client.ts",
        "src/db/migrate.ts",
        "src/db/schema.ts",
        "src/db/auth-schema.ts",
        "src/worker/index.ts",
        "src/worker/context.ts",
        "src/worker/handlers/relay.ts",
        "src/server/contracts.ts",
        "src/server/db-types.ts",
        // Stubs: the owning workstream deletes its line when it replaces the stub with real code.
        "src/server/waitlist/index.ts",
        "src/server/booking/reassign.ts",
        "src/server/notifications/waitlist-notifications.ts",
        "src/server/auth/access.ts",
        "src/worker/handlers/waitlist.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
