import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-colony/contracts": path.resolve("packages/contracts/src/index.ts"),
      "@ai-colony/core": path.resolve("packages/core/src/index.ts"),
      "@ai-colony/database": path.resolve("packages/database/src/index.ts"),
      "@ai-colony/messaging": path.resolve("packages/messaging/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
