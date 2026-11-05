import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessLedgerReadiness } from "@ai-colony/database";

loadProjectEnv();

const databaseUrl = process.env.DATABASE_URL ?? "postgres://colony:colony@127.0.0.1:5433/ai_colony";

try {
  const report = await assessLedgerReadiness(databaseUrl);
  console.log(JSON.stringify(report, null, 2));
  if (report.database === "unavailable") {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Ledger readiness failed";
  console.log(JSON.stringify({ status: "unavailable", database: "unavailable", detail: message }, null, 2));
  process.exitCode = 1;
}

function loadProjectEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
