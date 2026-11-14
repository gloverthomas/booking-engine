import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/db/**", "src/server/**", "src/worker/**"],
      exclude: [
        "src/db/client.ts",
        "src/db/migrate.ts",
        "src/db/schema.ts",
        "src/worker/index.ts",
        "src/worker/context.ts",
        "src/server/contracts.ts",
        "src/server/db-types.ts",
        // Stubs: the owning workstream deletes its line when it replaces the stub with real code.
        "src/server/availability/index.ts",
        "src/server/booking/index.ts",
        "src/server/payments/index.ts",
        "src/server/notifications/index.ts",
        "src/worker/handlers/notifications.ts",
        "src/worker/handlers/google.ts",
        "src/worker/handlers/xero.ts",
        "src/worker/handlers/payments.ts",
        "src/worker/handlers/relay.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
