import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://colony:colony@localhost:5433/ai_colony";

export default defineConfig({
  schema: "./packages/database/src/schema/index.ts",
  out: "./packages/database/src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
});
