import { vi } from "vitest";

// Each test file builds an in-process Postgres, which is slow when many files run in parallel (coverage runs).
vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });
