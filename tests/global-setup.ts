import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertIsolatedCompose } from "./helpers/isolation.js";
import { ensureTestDatabase } from "./helpers/db.js";

const execFileAsync = promisify(execFile);

export default async function setup(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const composePath = path.join(root, "docker-compose.integration.yml");
  assertIsolatedCompose(readFileSync(composePath, "utf8"));
  await execFileAsync(
    "docker",
    ["compose", "-f", composePath, "-p", "ai-colony-m101", "up", "-d", "--wait"],
    { cwd: root },
  );
  await ensureTestDatabase();
}
