import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-colony/contracts": path.resolve("packages/contracts/src/index.ts"),
      "@ai-colony/core": path.resolve("packages/core/src/index.ts"),
      "@ai-colony/database": path.resolve("packages/database/src/index.ts"),
      "@ai-colony/messaging": path.resolve("packages/messaging/src/index.ts"),
      "@ai-colony/inference": path.resolve("packages/inference/src/index.ts"),
      "@ai-colony/workflows": path.resolve("packages/workflows/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
