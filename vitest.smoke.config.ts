import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-colony/contracts": path.resolve("packages/contracts/src/index.ts"),
      "@ai-colony/core": path.resolve("packages/core/src/index.ts"),
      "@ai-colony/inference": path.resolve("packages/inference/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/smoke/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
