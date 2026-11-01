import { readFileSync } from "node:fs";
import { resolve } from "node:path";

loadProjectEnv();

const databaseUrl = process.env.DATABASE_URL ?? "postgres://colony:colony@127.0.0.1:5433/ai_colony";

export const ADMIN_DATABASE_URL = withDatabase(databaseUrl, "ai_colony");
export const TEST_DATABASE_URL = withDatabase(databaseUrl, "ai_colony_test");

function loadProjectEnv(): void {
  const path = resolve(process.cwd(), ".env");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    const name = match?.[1];
    const value = match?.[2];
    if (!name || value === undefined || process.env[name] !== undefined) {
      continue;
    }
    process.env[name] = value;
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
