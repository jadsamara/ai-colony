import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GEMMA3_270M_MODEL_ID, QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import { ScriptedTrainingProvider } from "@ai-colony/core";
import { schema, seed } from "@ai-colony/database";
import { ADMIN_ID, auth, createTestApp } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";

const WEIGHT = "00000000-0000-4000-8000-000000000208";
const CEO = "00000000-0000-4000-8000-000000000201";
const roots = {
  artifacts: mkdtempSync(join(tmpdir(), "colony-artifacts-")),
  checkpoints: mkdtempSync(join(tmpdir(), "colony-checkpoints-")),
};
const checkpointPath = join(roots.checkpoints, "gemma-3-270m", "model.safetensors");
const checkpointSha = createHash("sha256").update("gemma-3-270m-test-checkpoint").digest("hex");

describe("governed LoRA training", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    mkdirSync(join(roots.checkpoints, "gemma-3-270m"), { recursive: true });
    writeFileSync(checkpointPath, "gemma-3-270m-test-checkpoint");
    app = await createTestApp({ trainingRoots: roots });
  });

  beforeEach(async () => {
    await seed(testDb());
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects an unhashed or non-Gemma checkpoint and keeps Qwen untrained", async () => {
    const mismatch = await app.inject({
      method: "POST",
      url: "/api/v1/models/checkpoints",
      headers: auth(ADMIN_ID),
      payload: checkpointBody("a".repeat(64)),
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("ARTIFACT_MISMATCH");

    const qwen = await app.inject({
      method: "POST",
      url: "/api/v1/models/checkpoints",
      headers: auth(ADMIN_ID),
      payload: { ...checkpointBody(checkpointSha), registryModelId: QWEN3_8B_MODEL_ID, source: "qwen-relabel" },
    });
    expect(qwen.statusCode).toBe(409);
    expect(qwen.json().error.code).toBe("NOT_ELIGIBLE");
    const stored = await app.inject({ method: "GET", url: `/api/v1/models/${QWEN3_8B_MODEL_ID}`, headers: auth(ADMIN_ID) });
    expect(stored.json().model.status).toBe("not_deployed");
    expect(stored.json().model.artifactUri).toBeNull();
  });

  it("seals a curated dataset, blocks agent approval, and does not put the test split in the trainer file", async () => {
    const checkpointId = await register(app);
    const versionId = await dataset(app, "curated-main");
    const created = await app.inject({ method: "GET", url: `/api/v1/training/datasets/${versionId}`, headers: auth(WEIGHT) });
    const examples = created.json().dataset.examples as Array<{ split: string; groupKey: string; input: string }>;
    const trainKeys = new Set(examples.filter((row) => row.split === "train").map((row) => row.groupKey));
    const testRows = examples.filter((row) => row.split === "test");
    expect(testRows.length).toBeGreaterThan(0);
    expect(testRows.every((row) => !trainKeys.has(row.groupKey))).toBe(true);

    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/training/runs",
      headers: auth(WEIGHT),
      payload: runBody(checkpointId, versionId, "weight-propose-001"),
    });
    expect(denied.statusCode).toBe(201);
    const runId = denied.json().run.id as string;
    const agentApprove = await app.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/approve`, headers: auth(WEIGHT), payload: {} });
    const ceoApprove = await app.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/approve`, headers: auth(CEO), payload: {} });
    expect(agentApprove.statusCode).toBe(403);
    expect(ceoApprove.statusCode).toBe(403);

    const approved = await app.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/approve`, headers: auth(ADMIN_ID), payload: {} });
    const executed = await app.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/execute`, headers: auth(ADMIN_ID), payload: {} });
    expect(approved.statusCode).toBe(200);
    expect(executed.statusCode).toBe(200);
    expect(executed.json().run.status).toBe("evaluating");
    const trainerFile = readFileSync(join(roots.artifacts, "runs", runId, "data", "train.jsonl"), "utf8");
    const trainedInputs = new Set(
      trainerFile
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { messages: Array<{ content: string }> }).messages[0]?.content),
    );
    expect(testRows.some((row) => trainedInputs.has(row.input))).toBe(false);
    const artifacts = await app.inject({ method: "GET", url: `/api/v1/training/runs/${runId}/artifacts`, headers: auth(ADMIN_ID) });
    const artifact = artifacts.json().data[0] as { sha256: string; format: string; trainableParameters: number };
    expect(artifact.format).toBe("float32-bin");
    expect(artifact.trainableParameters).toBeGreaterThan(0);
    const bytes = readFileSync(join(roots.artifacts, "runs", runId, "adapter.weights"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);

    const evaluation = await app.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/evaluate`, headers: auth(ADMIN_ID), payload: {} });
    expect(evaluation.statusCode).toBe(200);
    expect(evaluation.json().acceptanceMet).toBe(true);
    expect(evaluation.json().candidate.numericCorrectness).toBeGreaterThan(evaluation.json().baseline.numericCorrectness);
    const again = await app.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/evaluate`, headers: auth(ADMIN_ID), payload: {} });
    expect(again.json().id).toBe(evaluation.json().id);
    const tamper = await app.inject({
      method: "POST",
      url: `/api/v1/training/runs/${runId}/evaluate`,
      headers: auth(ADMIN_ID),
      payload: { decoding: "greedy", criteria: { metric: "loss" } },
    });
    expect(tamper.statusCode).toBe(400);

    const candidateId = (await app.inject({ method: "GET", url: "/api/v1/models/candidates", headers: auth(WEIGHT) })).json().data[0].id as string;
    const selfPromote = await app.inject({
      method: "POST",
      url: `/api/v1/models/candidates/${candidateId}/promote`,
      headers: auth(WEIGHT),
      payload: { reason: "the department recommends it" },
    });
    expect(selfPromote.statusCode).toBe(403);
    const qwenBefore = await app.inject({ method: "GET", url: `/api/v1/models/${QWEN3_8B_MODEL_ID}`, headers: auth(ADMIN_ID) });
    const promoted = await app.inject({
      method: "POST",
      url: `/api/v1/models/candidates/${candidateId}/promote`,
      headers: auth(ADMIN_ID),
      payload: { reason: "held-out numeric accuracy improved under the frozen criteria" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().status).toBe("approved");
    const qwenAfter = await app.inject({ method: "GET", url: `/api/v1/models/${QWEN3_8B_MODEL_ID}`, headers: auth(ADMIN_ID) });
    expect(qwenAfter.json().model).toMatchObject(qwenBefore.json().model);
    const gemma = await app.inject({ method: "GET", url: `/api/v1/models/${GEMMA3_270M_MODEL_ID}`, headers: auth(ADMIN_ID) });
    expect(gemma.json().model.status).toBe("not_deployed");
    expect(gemma.json().model.artifactUri).toBeNull();

    const inferred = await app.inject({
      method: "POST",
      url: "/api/v1/models/experimental-inference",
      headers: auth(ADMIN_ID),
      payload: { candidateId, prompt: "6 + 1" },
    });
    expect(inferred.statusCode).toBe(200);
    expect(inferred.json()).toMatchObject({
      output: "7",
      framework: "scripted",
      loadedAdapter: true,
      usedProductionModel: false,
      productionModelId: QWEN3_8B_MODEL_ID,
      baseFamily: "gemma-3",
    });
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/training/runs" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("rejects a candidate that does not beat the frozen baseline", async () => {
    const flat = await createTestApp({ trainingProvider: new ScriptedTrainingProvider({ behavior: "flat" }), trainingRoots: roots });
    const checkpointId = await register(flat);
    const versionId = await dataset(flat, "curated-flat");
    const runId = await propose(flat, checkpointId, versionId, "flat-run-0001");
    await flat.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/approve`, headers: auth(ADMIN_ID), payload: {} });
    await flat.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/execute`, headers: auth(ADMIN_ID), payload: {} });
    const evaluation = await flat.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/evaluate`, headers: auth(ADMIN_ID), payload: {} });
    expect(evaluation.json().acceptanceMet).toBe(false);
    const candidateId = (await flat.inject({ method: "GET", url: "/api/v1/models/candidates", headers: auth(ADMIN_ID) })).json().data[0].id as string;
    const promoted = await flat.inject({
      method: "POST",
      url: `/api/v1/models/candidates/${candidateId}/promote`,
      headers: auth(ADMIN_ID),
      payload: { reason: "loss went down" },
    });
    expect(promoted.statusCode).toBe(409);
    expect(promoted.json().error.code).toBe("ACCEPTANCE_FAILED");
    await flat.close();
  });

  it("cancels an in-flight job, records a failed worker, and does not resume it after restart", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gated = await createTestApp({
      trainingProvider: new ScriptedTrainingProvider({ beforeFinish: async () => {
        entered();
        await gate;
      } }),
      trainingRoots: roots,
    });
    const checkpointId = await register(gated);
    const versionId = await dataset(gated, "curated-cancel");
    const runId = await propose(gated, checkpointId, versionId, "cancel-run-001");
    await gated.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/approve`, headers: auth(ADMIN_ID), payload: {} });
    const executing = gated.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/execute`, headers: auth(ADMIN_ID), payload: {} });
    await started;
    const cancelled = await gated.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/cancel`, headers: auth(ADMIN_ID), payload: {} });
    expect(cancelled.statusCode).toBe(200);
    release();
    const finished = await executing;
    expect(finished.statusCode).toBe(200);
    expect(finished.json().run.status).toBe("cancelled");
    await gated.close();

    const failing = await createTestApp({ trainingProvider: new ScriptedTrainingProvider({ fail: true }), trainingRoots: roots });
    const failedCheckpoint = await register(failing);
    const failedVersion = await dataset(failing, "curated-fail");
    const failedId = await propose(failing, failedCheckpoint, failedVersion, "failed-run-001");
    await failing.inject({ method: "POST", url: `/api/v1/training/runs/${failedId}/approve`, headers: auth(ADMIN_ID), payload: {} });
    const broken = await failing.inject({ method: "POST", url: `/api/v1/training/runs/${failedId}/execute`, headers: auth(ADMIN_ID), payload: {} });
    expect(broken.statusCode).toBe(422);
    const failed = await failing.inject({ method: "GET", url: `/api/v1/training/runs/${failedId}`, headers: auth(ADMIN_ID) });
    expect(failed.json().run.status).toBe("failed");
    expect(failed.json().run.error).toContain("worker_failed");
    const partial = await failing.inject({ method: "GET", url: `/api/v1/training/runs/${failedId}/artifacts`, headers: auth(ADMIN_ID) });
    expect(partial.json().data.length).toBeGreaterThan(0);
    const retried = await failing.inject({ method: "POST", url: `/api/v1/training/runs/${failedId}/retry`, headers: auth(ADMIN_ID), payload: {} });
    expect(retried.json().run.id).toBe(failedId);
    expect(retried.json().run.attempt).toBe(2);
    expect(retried.json().run.status).toBe("queued");
    await failing.close();

    await testDb().update(schema.trainingRuns).set({ status: "training" }).where(eq(schema.trainingRuns.id, failedId));
    const restarted = await createTestApp({ trainingRoots: roots });
    const recovered = await restarted.inject({ method: "GET", url: `/api/v1/training/runs/${failedId}`, headers: auth(ADMIN_ID) });
    expect(recovered.json().run.status).toBe("failed");
    expect(recovered.json().run.error).toContain("worker_lost");
    await restarted.close();
  });

  it("blocks a second job while one is training and reproduces a run without starting it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const busy = await createTestApp({
      trainingProvider: new ScriptedTrainingProvider({ beforeFinish: async () => {
        entered();
        await gate;
      } }),
      trainingRoots: roots,
    });
    const checkpointId = await register(busy);
    const versionId = await dataset(busy, "curated-busy");
    const first = await propose(busy, checkpointId, versionId, "busy-run-0001");
    const second = await propose(busy, checkpointId, versionId, "busy-run-0002");
    await busy.inject({ method: "POST", url: `/api/v1/training/runs/${first}/approve`, headers: auth(ADMIN_ID), payload: {} });
    await busy.inject({ method: "POST", url: `/api/v1/training/runs/${second}/approve`, headers: auth(ADMIN_ID), payload: {} });
    const executing = busy.inject({ method: "POST", url: `/api/v1/training/runs/${first}/execute`, headers: auth(ADMIN_ID), payload: {} });
    await started;
    const rejected = await busy.inject({ method: "POST", url: `/api/v1/training/runs/${second}/execute`, headers: auth(ADMIN_ID), payload: {} });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe("BUDGET_EXCEEDED");
    release();
    await executing;
    const copy = await busy.inject({
      method: "POST",
      url: `/api/v1/training/runs/${first}/reproduce`,
      headers: auth(WEIGHT),
      payload: { idempotencyKey: "busy-reproduce-01" },
    });
    expect(copy.statusCode).toBe(201);
    expect(copy.json().run.id).not.toBe(first);
    expect(copy.json().run.parentRunId).toBe(first);
    expect(copy.json().run.status).toBe("awaiting_approval");
    expect(copy.json().run.startedAt).toBeNull();
    await busy.close();
  });

  it("does not train on model-generated memory", async () => {
    const memory = await app.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: auth(WEIGHT),
      payload: {
        scope: "agent",
        category: "semantic",
        title: "generated sum",
        summary: "model output",
        content: "INPUT: 2 + 2\nOUTPUT: 4",
        provenance: "model_generated",
        idempotencyKey: `memory-${randomUUID()}`,
      },
    });
    expect(memory.statusCode).toBe(201);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/training/datasets",
      headers: auth(WEIGHT),
      payload: { name: "memory-excluded", taskDomain: "structured-arithmetic", source: "memories", memoryIds: [memory.json().memory.id], idempotencyKey: "memory-dataset-1" },
    });
    expect(rejected.statusCode).toBe(422);
  });
});

function checkpointBody(sha: string) {
  return {
    registryModelId: GEMMA3_270M_MODEL_ID,
    checkpointPath,
    expectedSha256: sha,
    source: "local-gemma-fixture",
    revision: "test",
    tokenizerId: "gemma-3-270m",
    precision: "bf16",
    architecture: "gemma3_text",
    framework: "mlx-lm",
    frameworkVersion: "test",
    license: "gemma",
    contextLength: 32768,
  };
}

async function register(target: Awaited<ReturnType<typeof createTestApp>>): Promise<string> {
  const response = await target.inject({ method: "POST", url: "/api/v1/models/checkpoints", headers: auth(ADMIN_ID), payload: checkpointBody(checkpointSha) });
  if (response.statusCode !== 201) {
    throw new Error(response.body);
  }
  return response.json().checkpoint.id as string;
}

async function dataset(target: Awaited<ReturnType<typeof createTestApp>>, key: string): Promise<string> {
  const response = await target.inject({
    method: "POST",
    url: "/api/v1/training/datasets",
    headers: auth(WEIGHT),
    payload: { name: key, taskDomain: "structured-arithmetic", source: "curated_arithmetic", exampleCount: 48, seed: 7, idempotencyKey: key },
  });
  if (response.statusCode !== 201) {
    throw new Error(response.body);
  }
  return response.json().dataset.versionId as string;
}

async function propose(target: Awaited<ReturnType<typeof createTestApp>>, checkpointId: string, versionId: string, key: string): Promise<string> {
  const response = await target.inject({
    method: "POST",
    url: "/api/v1/training/runs",
    headers: auth(WEIGHT),
    payload: runBody(checkpointId, versionId, key),
  });
  if (response.statusCode !== 201) {
    throw new Error(response.body);
  }
  return response.json().run.id as string;
}

function runBody(trainableModelId: string, datasetVersionId: string, idempotencyKey: string) {
  return { trainableModelId, datasetVersionId, profile: "gemma3-270m-math-v1", seed: 7, idempotencyKey };
}
