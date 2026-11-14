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
      include: ["src/lib/**", "src/db/**", "src/worker/**"],
      exclude: ["src/db/client.ts", "src/db/migrate.ts", "src/db/schema.ts", "src/worker/index.ts"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
