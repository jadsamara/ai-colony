import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createReadOnlyInspection } from "@ai-colony/database";
import {
  API_PROCESS,
  DISPATCHER_PROCESS,
  TRAINING_PROCESS,
  WORKER_PROCESS,
  artifactPresence,
  buildRuntimeReport,
  commandLines,
  describeModelHealth,
  processSeen,
  summarizeOutbox,
  tcpReachable,
  type OutboxObservation,
} from "@ai-colony/core";
import { OllamaStatusClient, loadInferenceConfig } from "@ai-colony/inference";

loadProjectEnv();

const databaseUrl = process.env.DATABASE_URL ?? "postgres://colony:colony@127.0.0.1:5433/ai_colony";
const inference = loadInferenceConfig(process.env);
const checkedAt = new Date().toISOString();
const now = Date.now();

const database = await readDatabase();
const observation = await new OllamaStatusClient({
  baseUrl: inference.baseUrl,
  timeoutMs: inference.probeTimeoutMs,
  freshnessMs: inference.probeFreshnessMs,
  minIntervalMs: inference.probeMinIntervalMs,
}).inspect();
const lines = await commandLines();
const rabbit = rabbitEndpoint();
const rabbitReachable = rabbit ? await tcpReachable(rabbit.host, rabbit.port) : null;
const apiPort = Number(process.env.PORT ?? 3000);
const apiListening = (await tcpReachable("127.0.0.1", apiPort)) || processSeen(lines, API_PROCESS) === true;
const model = describeModelHealth({
  alias: inference.alias,
  registered: database.primaryPresent || database.registeredAliases.includes(inference.alias),
  artifacts: artifactPresence(inference.alias, homedir(), existsSync),
  persisted: database.persisted,
  observation,
  lastSuccessfulInferenceAt: database.latestInferenceAt,
  now,
  freshnessMs: inference.probeFreshnessMs,
});
const summary = summarizeOutbox(database.outbox, now);
const pending = summary.counts.pending ?? 0;
const oldestPending = database.outbox
  .filter((row) => row.status === "pending")
  .map((row) => Date.parse(row.updatedAt))
  .filter((value) => Number.isFinite(value))
  .sort((left, right) => left - right)[0];

const report = {
  ...buildRuntimeReport({
    checkedAt,
    postgres: database.postgres,
    rabbitReachable,
    apiListening,
    workers: {
      heartbeats: database.heartbeats,
      processSeen: processSeen(lines, WORKER_PROCESS),
      now,
      staleAfterMs: Number(process.env.RUNTIME_STALE_AFTER_MS ?? 30_000),
    },
    dispatcher: {
      processSeen: processSeen(lines, DISPATCHER_PROCESS),
      pending: database.postgres.connected ? pending : null,
    },
    registry: database.postgres.connected
      ? { registered: database.registeredNames, installed: observation.installedNames }
      : null,
    training: {
      provider: process.env.TRAINING_PROVIDER ?? "scripted",
      processSeen: processSeen(lines, TRAINING_PROCESS),
      lastExperimentAt: database.lastExperimentAt,
    },
    model,
    outbox: {
      pending,
      publishing: summary.counts.publishing ?? 0,
      published: summary.counts.published ?? 0,
      failed: summary.counts.failed ?? 0,
      oldest_pending_age_ms: oldestPending === undefined ? null : Math.max(0, now - oldestPending),
      delivery_guarantee: "at-least-once" as const,
    },
  }),
  outbox_detail: database.postgres.connected ? summary : null,
  ollama_endpoints: ["/api/version", "/api/tags", "/api/ps"],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function rabbitEndpoint(): { host: string; port: number } | null {
  try {
    const url = new URL(process.env.RABBITMQ_URL ?? "amqp://127.0.0.1:5672");
    return { host: url.hostname || "127.0.0.1", port: Number(url.port || 5672) };
  } catch {
    return null;
  }
}

async function readDatabase(): Promise<{
  postgres: {
    connected: boolean;
    database: string | null;
    dataDirectory: string | null;
    session: "read-only" | "application" | "unknown";
  };
  persisted: {
    runtimeStatus: string;
    expectedAlias: string | null;
    loadedModelId: string | null;
    endpointUrl: string | null;
    lastError: string | null;
    probedAt: string | null;
  } | null;
  registeredAliases: string[];
  registeredNames: string[];
  primaryPresent: boolean;
  latestInferenceAt: string | null;
  lastExperimentAt: string | null;
  heartbeats: Array<{ role: string; beatAt: string }>;
  outbox: OutboxObservation[];
}> {
  const empty = {
    postgres: {
      connected: false,
      database: null,
      dataDirectory: null,
      session: "unknown" as const,
    },
    persisted: null,
    registeredAliases: [],
    registeredNames: [],
    primaryPresent: false,
    latestInferenceAt: null,
    lastExperimentAt: null,
    heartbeats: [],
    outbox: [],
  };
  let inspection: ReturnType<typeof createReadOnlyInspection> | null = null;
  try {
    inspection = createReadOnlyInspection(databaseUrl);
    await inspection.assertReadOnly();
    const [identity] = await inspection.sql<{ name: string }[]>`SELECT current_database() AS name`;
    const [directory] = await inspection.sql<{ data_directory: string }[]>`SHOW data_directory`;
    const models = await inspection.sql<
      {
        display_name: string;
        runtime_status: string | null;
        expected_alias: string | null;
        loaded_model_id: string | null;
        endpoint_url: string | null;
        last_error: string | null;
        probed_at: Date | string | null;
      }[]
    >`
      SELECT m.display_name, r.runtime_status, r.expected_alias, r.loaded_model_id,
             r.endpoint_url, r.last_error, r.probed_at
      FROM models m
      LEFT JOIN model_runtimes r ON r.model_id = m.id
      WHERE m.display_name = 'Qwen3-8B' OR r.expected_alias = ${inference.alias}
    `;
    const names = await inspection.sql<{ display_name: string; expected_alias: string | null }[]>`
      SELECT m.display_name, r.expected_alias
      FROM models m
      LEFT JOIN model_runtimes r ON r.model_id = m.id
    `;
    const [latest] = await inspection.sql<{ latest: Date | string | null }[]>`
      SELECT max(completed_at) AS latest FROM inference_requests WHERE status = 'completed'
    `;
    const [experiment] = await inspection.sql<{ latest: Date | string | null }[]>`
      SELECT max(created_at) AS latest FROM training_experiments
    `;
    const heartbeats = await inspection.sql<{ role: string; beat_at: Date | string }[]>`
      SELECT role, beat_at FROM worker_heartbeats
    `;
    const outbox = await inspection.sql<
      {
        status: string;
        message_type: string;
        publish_attempts: number;
        updated_at: Date | string;
        last_error: string | null;
      }[]
    >`
      SELECT o.status, m.message_type, o.publish_attempts, o.updated_at, o.last_error
      FROM message_outbox o
      JOIN messages m ON m.id = o.message_id
    `;
    const primary = models[0];
    return {
      postgres: {
        connected: true,
        database: identity?.name ?? null,
        dataDirectory: directory?.data_directory ?? null,
        session: "read-only",
      },
      persisted: primary
        ? {
            runtimeStatus: primary.runtime_status ?? "not_deployed",
            expectedAlias: primary.expected_alias,
            loadedModelId: primary.loaded_model_id,
            endpointUrl: primary.endpoint_url,
            lastError: primary.last_error,
            probedAt: primary.probed_at ? iso(primary.probed_at) : null,
          }
        : null,
      registeredAliases: names.map((row) => row.expected_alias).filter((alias): alias is string => Boolean(alias)),
      registeredNames: names.map((row) => row.display_name),
      primaryPresent: names.some((row) => row.display_name === "Qwen3-8B"),
      latestInferenceAt: latest?.latest ? iso(latest.latest) : null,
      lastExperimentAt: experiment?.latest ? iso(experiment.latest) : null,
      heartbeats: heartbeats.map((row) => ({ role: row.role, beatAt: iso(row.beat_at) })),
      outbox: outbox.map((row) => ({
        status: row.status,
        messageType: row.message_type,
        publishAttempts: Number(row.publish_attempts),
        updatedAt: iso(row.updated_at),
        lastError: row.last_error,
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "inspection failed";
    process.stderr.write(`postgresql inspection failed: ${message.replace(/postgres:\/\/\S+/g, "postgres://redacted")}\n`);
    return empty;
  } finally {
    await inspection?.close();
  }
}

function loadProjectEnv(): void {
  let text = "";
  try {
    text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
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

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
