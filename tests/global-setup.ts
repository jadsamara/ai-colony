import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { ADMIN_DATABASE_URL } from "./helpers/env.js";
import { ensureTestDatabase } from "./helpers/db.js";

const execFileAsync = promisify(execFile);

async function postgresReady(): Promise<boolean> {
  const client = postgres(ADMIN_DATABASE_URL, { max: 1, connect_timeout: 2 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

export default async function setup(): Promise<void> {
  if (!(await postgresReady())) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    await execFileAsync("docker", ["compose", "up", "-d", "--wait"], { cwd: root });
  }
  if (!(await postgresReady())) {
    throw new Error(`PostgreSQL did not become ready at ${ADMIN_DATABASE_URL}`);
  }
  await ensureTestDatabase();
}
