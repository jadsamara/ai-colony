import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEDICATED_SERVING_POLICY_VERSION,
  assertDedicatedCapacity,
  bindDedicatedEndpoints,
  composeStopInvocation,
  departmentProfiles,
  estimateDedicatedCapacity,
  inventoryDepartmentStatus,
  limitsFromEnv,
  planDedicatedInstances,
  planModelArtifacts,
  probeServingEndpoint,
  renderDedicatedCompose,
  writeActivationAtomic,
  type DepartmentSource,
} from "@ai-colony/core";
import { createDatabase } from "./client.js";
import { applyCanonicalMigration, readMigrationFile, servingConstraintNames } from "./canonical.js";
import { SEED_AGENTS, SEED_DEPARTMENTS } from "./seed.js";
import { installProductDepartment } from "./product-install.js";
import { ensureDedicatedInventory, listDedicatedInstances, recordServingStatus } from "./serving-inventory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadOptionalEnv(path.join(root, ".env"));
const command = process.argv[2] ?? "";
function loadOptionalEnv(file: string): void {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Z0-9_]+$/.test(key) || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = trimmed.slice(separator + 1).trim().replace(/^"|"$/g, "");
  }
}

const realFile = "deploy/docker-compose.gcp.yml";
const mockFile = "deploy/docker-compose.mock.yml";

const departments: DepartmentSource[] = SEED_DEPARTMENTS.map(([id, name, slug, , purpose]) => ({
  id,
  name,
  slug,
  status: inventoryDepartmentStatus(slug),
  purpose,
}));
const profiles = departmentProfiles(
  departments,
  SEED_AGENTS.map(([id, departmentId]) => ({ id, departmentId })),
);
const instances = planDedicatedInstances(profiles);

function stageMockImage(): void {
  const dest = path.join(root, "deploy/mock-image");
  mkdirSync(dest, { recursive: true });
  copyFileSync(path.join(root, "deploy/Dockerfile.mock"), path.join(dest, "Dockerfile"));
  for (const name of ["mock-cli.js", "mock-department.js", "department-process.js"]) {
    copyFileSync(path.join(root, "packages/inference/dist", name), path.join(dest, name));
  }
}

function writeComposeFiles(): void {
  for (const mode of ["real", "mock"] as const) {
    const document = renderDedicatedCompose({ mode, profiles, instances });
    writeFileSync(path.join(root, document.fileName), document.yaml);
  }
}

function expectedDigests(): Record<string, string> {
  if (!process.env.COLONY_MODEL_DIGESTS) {
    return {};
  }
  return JSON.parse(process.env.COLONY_MODEL_DIGESTS) as Record<string, string>;
}

function observations() {
  const file = path.join(root, "deploy/state/artifacts.json");
  let recorded: Record<string, string> = {};
  try {
    recorded = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    recorded = {};
  }
  return instances.map((instance) => ({
    instanceId: instance.instanceId,
    recordedDigest: recorded[instance.instanceId] ?? null,
    measuredBytes: null,
  }));
}

function preflight(mode: "real" | "mock") {
  const bound = bindDedicatedEndpoints(instances, {
    resolve: (reference) => {
      const slug = reference.slice("serving://".length);
      return mode === "mock" ? `http://mock-${slug}:8080` : `http://ollama-${slug}:11434`;
    },
  });
  const estimate = estimateDedicatedCapacity(bound.length);
  const capacity = assertDedicatedCapacity(estimate, limitsFromEnv(process.env, null), mode);
  const artifacts = planModelArtifacts({
    instances: bound,
    observations: observations(),
    expectedDigests: expectedDigests(),
    mode,
    allowDownload: process.env.COLONY_ALLOW_MODEL_DOWNLOAD === "true",
  });
  return { bound, capacity, artifacts };
}

function run(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0] ?? "docker", args.slice(1), { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function capture(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0] ?? "docker", args.slice(1), { cwd: root });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function compose(file: string, args: string[]): Promise<number> {
  return run(["docker", "compose", "-f", file, ...args]);
}

async function requireHealthy(file: string): Promise<void> {
  const listed = await capture(["docker", "compose", "-f", file, "ps", "--format", "json"]);
  if (listed.code !== 0) {
    throw new Error("docker compose ps failed");
  }
  const rows = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { Service?: string; Health?: string; State?: string });
  const unhealthy = rows.filter((row) => row.Health !== "healthy" || row.State !== "running");
  if (rows.length === 0 || unhealthy.length > 0) {
    throw new Error(`Services are not healthy: ${unhealthy.map((row) => row.Service ?? "unknown").join(", ") || "none reported"}`);
  }
}

async function provision(mode: "real" | "mock"): Promise<void> {
  stageMockImage();
  writeComposeFiles();
  const check = preflight(mode);
  if (!check.capacity.ok || !check.artifacts.ok) {
    process.stderr.write(`${check.capacity.reason ?? check.artifacts.reason}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`${mode} provision accepted ${check.bound.length} dedicated endpoints. Model download was not requested.`);
}

async function start(mode: "real" | "mock"): Promise<void> {
  await provision(mode);
  if (process.exitCode) {
    return;
  }
  const file = mode === "mock" ? mockFile : realFile;
  if (mode === "mock") {
    const built = await compose(file, ["build"]);
    if (built !== 0) {
      process.exitCode = built;
      return;
    }
  }
  const args = mode === "mock" ? ["up", "-d", "--wait", "--pull", "never"] : ["up", "-d", "--wait"];
  const code = await compose(file, args);
  if (code !== 0) {
    process.exitCode = code;
    return;
  }
  await requireHealthy(file);
  console.log(mode === "mock" ? "Mock deployment is up. This is not a real Qwen deployment." : "Dedicated services reported healthy.");
}

async function stop(mode: "real" | "mock"): Promise<void> {
  const file = mode === "mock" ? mockFile : realFile;
  const invocation = composeStopInvocation(file);
  if (invocation.join(" ").includes("-v")) {
    throw new Error("Stop command must not delete volumes");
  }
  process.exitCode = await run(invocation);
}

async function status(mode: "real" | "mock"): Promise<void> {
  const file = mode === "mock" ? mockFile : realFile;
  const code = await compose(file, ["ps"]);
  if (code !== 0) {
    process.exitCode = code;
    return;
  }
  await requireHealthy(file);
}

async function activate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (new URL(databaseUrl).port === "5434") {
    throw new Error("Refusing PostgreSQL port 5434");
  }
  const { db, close } = createDatabase(databaseUrl);
  try {
    const stored = await listDedicatedInstances(db);
    const bound = bindDedicatedEndpoints(stored, {
      resolve: (reference) => {
        const slug = reference.slice("serving://".length);
        return process.env.COLONY_MODE === "mock" ? `http://mock-${slug}:8080` : `http://ollama-${slug}:11434`;
      },
    });
    const ready: string[] = [];
    for (const instance of bound) {
      const live = await probeServingEndpoint(instance.normalizedEndpoint, 2_000);
      await recordServingStatus(
        db,
        instance.instanceId,
        live ? "ready" : "unavailable",
        live ? "Readiness probe succeeded" : "Readiness probe failed. No shared fallback was used.",
      );
      if (live) {
        ready.push(instance.instanceId);
      }
    }
    const file = path.join(root, "deploy/state/dedicated-routing.json");
    if (ready.length !== bound.length || bound.length === 0) {
      writeActivationAtomic(file, {
        enabled: false,
        policyVersion: DEDICATED_SERVING_POLICY_VERSION,
        activatedAt: null,
        instanceIds: ready,
        mode: process.env.COLONY_MODE === "mock" ? "mock" : "real",
      });
      throw new Error(`Dedicated routing stays off. ${ready.length} of ${bound.length} instances answered a readiness probe.`);
    }
    writeActivationAtomic(file, {
      enabled: true,
      policyVersion: DEDICATED_SERVING_POLICY_VERSION,
      activatedAt: new Date().toISOString(),
      instanceIds: ready,
      mode: process.env.COLONY_MODE === "mock" ? "mock" : "real",
    });
    console.log("Dedicated routing file is enabled. Restart workers with COLONY_DEDICATED_ROUTING=on. COLONY_ACCEPT_TASKS stays false until you set it.");
  } finally {
    await close();
  }
}

async function deactivate(): Promise<void> {
  const file = path.join(root, "deploy/state/dedicated-routing.json");
  writeActivationAtomic(file, {
    enabled: false,
    policyVersion: DEDICATED_SERVING_POLICY_VERSION,
    activatedAt: null,
    instanceIds: [],
    mode: process.env.COLONY_MODE === "mock" ? "mock" : "real",
  });
  if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).port === "5434") {
    console.log("Dedicated routing file is disabled.");
    return;
  }
  const { db, close } = createDatabase(process.env.DATABASE_URL);
  try {
    const stored = await listDedicatedInstances(db);
    for (const instance of stored) {
      if (instance.status === "ready") {
        await recordServingStatus(db, instance.instanceId, "configured", "Dedicated routing was deactivated. The registry record is not readiness.");
      }
    }
  } finally {
    await close();
  }
  console.log("Dedicated routing is off. Existing task pins were not rewritten.");
}

async function migrateCanonical(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  mkdirSync(path.join(root, "deploy/state"), { recursive: true });
  const sql = readMigrationFile(path.join(root, "packages/database/src/migrations/0013_product_department.sql"));
  const result = await applyCanonicalMigration(databaseUrl, sql);
  const { db, close } = createDatabase(databaseUrl);
  try {
    const product = await installProductDepartment(db);
    const inventory = await ensureDedicatedInventory(db);
    const constraints = await servingConstraintNames(db);
    console.log(JSON.stringify({
      applied: result.applied,
      routingDecisions: result.routingDecisionsAfter,
      dataDirectory: result.identityBefore.dataDirectory,
      activeDepartments: inventory.activeDepartments,
      insertedAgents: inventory.insertedAgents,
      insertedInstances: inventory.insertedInstances,
      engineeringStatus: inventory.engineeringStatus,
      product,
      endpoints: inventory.instances.map((instance) => instance.endpointReference),
      constraints,
    }, null, 2));
  } finally {
    await close();
  }
}

try {
  if (command === "provision") {
    await provision("real");
  } else if (command === "provision-mock") {
    await provision("mock");
  } else if (command === "start") {
    await start("real");
  } else if (command === "start-mock") {
    await start("mock");
  } else if (command === "stop") {
    await stop("real");
  } else if (command === "stop-mock") {
    await stop("mock");
  } else if (command === "restart") {
    await stop("real");
    if (!process.exitCode) {
      await start("real");
    }
  } else if (command === "restart-mock") {
    await stop("mock");
    if (!process.exitCode) {
      await start("mock");
    }
  } else if (command === "status") {
    await status(process.env.COLONY_MODE === "mock" ? "mock" : "real");
  } else if (command === "logs") {
    const file = process.env.COLONY_MODE === "mock" ? mockFile : realFile;
    process.exitCode = await compose(file, ["logs", "--tail", "80", "--no-color"]);
  } else if (command === "routing-activate") {
    await activate();
  } else if (command === "routing-deactivate") {
    await deactivate();
  } else if (command === "migrate-canonical") {
    await migrateCanonical();
  } else if (command === "write-compose") {
    writeComposeFiles();
  } else {
    process.stderr.write("Usage: colony-cli <provision|start|stop|restart|status|logs|start-mock|stop-mock|routing-activate|routing-deactivate|migrate-canonical>\n");
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "colony command failed"}\n`);
  process.exitCode = 1;
}
