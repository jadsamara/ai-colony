import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Docker bind-mount permission checks for C1.8C.
 * Intentionally separate from vitest.integration.config.ts so these tests
 * never open PostgreSQL or inherit DATABASE_URL.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ai-colony/contracts": path.resolve("packages/contracts/src/index.ts"),
      "@ai-colony/core": path.resolve("packages/core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/sandbox/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
