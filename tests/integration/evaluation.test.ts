import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMMA3_270M_MODEL_ID, QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import { schema } from "@ai-colony/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ID, auth, createTestApp } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";
import { seed } from "@ai-colony/database";

const EVAL = "00000000-0000-4000-8000-000000000209";
const CEO = "00000000-0000-4000-8000-000000000201";
const roots = {
  artifacts: mkdtempSync(join(tmpdir(), "colony-m6-artifacts-")),
  checkpoints: mkdtempSync(join(tmpdir(), "colony-m6-checkpoints-")),
};
const checkpointPath = join(roots.checkpoints, "gemma-3-270m", "model.safetensors");
const checkpointSha = createHash("sha256").update("gemma-3-270m-test-checkpoint").digest("hex");
const historical = {
  baselineOutputs: ["0 + 1 = 1", "0 + 10 = 1", "0 + 7 = 7", "1 + 12 = 1", "2 + 7 = 9"],
  candidateOutputs: ["11", "10", "11", "15", "19"],
};

describe("evaluation, forgetting, and rollback", () => {
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

  it("keeps the M5 row, fails the new arithmetic gate, and hides sealed prompts", async () => {
    const trained = await trainCandidate(app);
    const m5 = await app.inject({ method: "POST", url: `/api/v1/training/runs/${trained.runId}/evaluate`, headers: auth(ADMIN_ID), payload: {} });
    expect(m5.statusCode).toBe(200);
    const suite = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations/suites",
      headers: auth(EVAL),
      payload: { slug: "m5-arithmetic-holdout", name: "M5 arithmetic holdout" },
    });
    const version = await app.inject({
      method: "POST",
      url: `/api/v1/evaluations/suites/${suite.json().id}/versions`,
      headers: auth(EVAL),
      payload: {
        description: "The five held-out sums from the M5 experiment",
        domain: "arithmetic",
        source: "m5-holdout",
        license: "internal",
        protocol: "greedy 8 tokens",
        sealed: true,
        items: [
          { prompt: "0 + 1", expected: "1" },
          { prompt: "0 + 10", expected: "10" },
          { prompt: "0 + 7", expected: "7" },
          { prompt: "1 + 12", expected: "13" },
          { prompt: "2 + 7", expected: "9" },
        ],
      },
    });
    expect(version.statusCode).toBe(201);
    const denied = await app.inject({ method: "POST", url: `/api/v1/evaluations/versions/${version.json().id}/publish`, headers: auth(EVAL) });
    expect(denied.statusCode).toBe(403);
    const published = await app.inject({ method: "POST", url: `/api/v1/evaluations/versions/${version.json().id}/publish`, headers: auth(ADMIN_ID) });
    expect(published.statusCode).toBe(200);
    const hidden = await app.inject({ method: "GET", url: `/api/v1/evaluations/versions/${version.json().id}`, headers: auth(CEO) });
    expect(hidden.json().items).toEqual([]);
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations/runs",
      headers: auth(ADMIN_ID),
      payload: { versionId: version.json().id, candidateId: trained.candidateId, source: "historical", ...historical },
    });
    expect(run.statusCode).toBe(201);
    expect(run.json().summary.taskBaseline).toBeCloseTo(0.6);
    expect(run.json().summary.taskCandidate).toBeCloseTo(0.2);
    expect(run.json().summary.claimSignificance).toBe(false);
    const agentGate = await app.inject({ method: "POST", url: `/api/v1/evaluations/runs/${run.json().runId}/gate`, headers: auth(EVAL) });
    expect(agentGate.statusCode).toBe(403);
    const gate = await app.inject({ method: "POST", url: `/api/v1/evaluations/runs/${run.json().runId}/gate`, headers: auth(ADMIN_ID) });
    expect(gate.json().decision).toBe("FAIL");
    const again = await app.inject({ method: "GET", url: `/api/v1/training/runs/${trained.runId}`, headers: auth(ADMIN_ID) });
    expect(again.json().run.status).toBe("completed");
    const preserved = await app.inject({ method: "POST", url: `/api/v1/training/runs/${trained.runId}/evaluate`, headers: auth(ADMIN_ID), payload: {} });
    expect(preserved.json().id).toBe(m5.json().id);
    expect(preserved.json().acceptanceMet).toBe(true);
  });

  it("forgets a disposable memory without removing its audit tombstone", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: auth(EVAL),
      payload: {
        scope: "agent",
        category: "semantic",
        title: "disposable",
        summary: "temporary",
        content: "DISPOSABLE-SECRET-PHRASE",
        provenance: "user_provided",
        idempotencyKey: "forget-memory-0001",
      },
    });
    expect(created.statusCode).toBe(201);
    const memoryId = created.json().memory.id as string;
    const visible = await app.inject({ method: "GET", url: `/api/v1/memories/${memoryId}`, headers: auth(EVAL) });
    expect(visible.statusCode).toBe(200);
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forgetting-requests",
      headers: auth(EVAL),
      payload: { memoryId, idempotencyKey: "forget-request-0001" },
    });
    expect(requested.statusCode).toBe(201);
    expect(JSON.stringify(requested.json().impact)).not.toContain("DISPOSABLE-SECRET-PHRASE");
    expect(requested.json().impact.relation).toBe("not_used");
    const selfApprove = await app.inject({ method: "POST", url: `/api/v1/memory/forgetting-requests/${requested.json().id}/approve`, headers: auth(EVAL) });
    expect(selfApprove.statusCode).toBe(403);
    await app.inject({ method: "POST", url: `/api/v1/memory/forgetting-requests/${requested.json().id}/approve`, headers: auth(ADMIN_ID) });
    const executed = await app.inject({ method: "POST", url: `/api/v1/memory/forgetting-requests/${requested.json().id}/execute`, headers: auth(ADMIN_ID) });
    expect(executed.json().status).toBe("completed");
    const hidden = await app.inject({ method: "GET", url: `/api/v1/memories/${memoryId}`, headers: auth(ADMIN_ID) });
    expect(hidden.statusCode).toBe(404);
    const audits = await testDb().select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, memoryId));
    expect(audits.some((row) => row.eventType === "memory.forgotten")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("DISPOSABLE-SECRET-PHRASE");
  });

  it("rolls an experimental route back to the adapter and restores the previous route if verification fails", async () => {
    const trained = await trainCandidate(app);
    const qwenBefore = await app.inject({ method: "GET", url: `/api/v1/models/${QWEN3_8B_MODEL_ID}`, headers: auth(ADMIN_ID) });
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/models/experimental-routes",
      headers: auth(ADMIN_ID),
      payload: { slug: "experimental", kind: "candidate", candidateId: trained.candidateId },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/models/experimental-routes",
      headers: auth(ADMIN_ID),
      payload: { slug: "experimental", kind: "baseline", trainableModelId: trained.trainableModelId },
    });
    expect(second.json().version).toBe(2);
    const requested = await app.inject({
      method: "POST",
      url: `/api/v1/models/experimental-routes/${first.json().routeId}/rollback-requests`,
      headers: auth(EVAL),
      payload: { toVersion: 1, reason: "restore the adapter route" },
    });
    const self = await app.inject({ method: "POST", url: `/api/v1/models/rollback-requests/${requested.json().id}/approve`, headers: auth(EVAL) });
    expect(self.statusCode).toBe(403);
    await app.inject({ method: "POST", url: `/api/v1/models/rollback-requests/${requested.json().id}/approve`, headers: auth(ADMIN_ID) });
    const executed = await app.inject({ method: "POST", url: `/api/v1/models/rollback-requests/${requested.json().id}/execute`, headers: auth(ADMIN_ID) });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().verification.loadedAdapter).toBe(true);
    expect(executed.json().verification.adapterSha256).toBe(trained.adapterSha);
    const qwenAfter = await app.inject({ method: "GET", url: `/api/v1/models/${QWEN3_8B_MODEL_ID}`, headers: auth(ADMIN_ID) });
    expect(qwenAfter.json().model).toMatchObject(qwenBefore.json().model);

    const third = await app.inject({
      method: "POST",
      url: "/api/v1/models/experimental-routes",
      headers: auth(ADMIN_ID),
      payload: { slug: "experimental", kind: "baseline", trainableModelId: trained.trainableModelId },
    });
    expect(third.json().version).toBe(3);
    await testDb().update(schema.experimentalRouteVersions).set({ adapterSha256: "b".repeat(64) }).where(eq(schema.experimentalRouteVersions.version, 1));
    const badRequest = await app.inject({
      method: "POST",
      url: `/api/v1/models/experimental-routes/${first.json().routeId}/rollback-requests`,
      headers: auth(EVAL),
      payload: { toVersion: 1, reason: "bad checksum" },
    });
    await app.inject({ method: "POST", url: `/api/v1/models/rollback-requests/${badRequest.json().id}/approve`, headers: auth(ADMIN_ID) });
    const failed = await app.inject({ method: "POST", url: `/api/v1/models/rollback-requests/${badRequest.json().id}/execute`, headers: auth(ADMIN_ID) });
    expect(failed.statusCode).toBe(409);
    const routes = await app.inject({ method: "GET", url: "/api/v1/models/experimental-routes", headers: auth(ADMIN_ID) });
    expect(routes.json().data[0].currentVersion).toBe(3);
  });
});

async function trainCandidate(target: Awaited<ReturnType<typeof createTestApp>>) {
  const registered = await target.inject({
    method: "POST",
    url: "/api/v1/models/checkpoints",
    headers: auth(ADMIN_ID),
    payload: {
      registryModelId: GEMMA3_270M_MODEL_ID,
      checkpointPath,
      expectedSha256: checkpointSha,
      source: "local-gemma-fixture",
      revision: "test",
      tokenizerId: "gemma-3-270m",
      precision: "bf16",
      architecture: "gemma3_text",
      framework: "mlx-lm",
      frameworkVersion: "test",
      license: "gemma",
      contextLength: 32768,
    },
  });
  const dataset = await target.inject({
    method: "POST",
    url: "/api/v1/training/datasets",
    headers: auth(EVAL),
    payload: { name: `m6-${Date.now()}`, taskDomain: "structured-arithmetic", source: "curated_arithmetic", exampleCount: 48, seed: 7, idempotencyKey: `m6-data-${Date.now()}` },
  });
  const proposed = await target.inject({
    method: "POST",
    url: "/api/v1/training/runs",
    headers: auth(EVAL),
    payload: {
      trainableModelId: registered.json().checkpoint.id,
      datasetVersionId: dataset.json().dataset.versionId,
      profile: "gemma3-270m-math-v1",
      seed: 7,
      idempotencyKey: `m6-run-${Date.now()}`,
    },
  });
  const runId = proposed.json().run.id as string;
  await target.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/approve`, headers: auth(ADMIN_ID), payload: {} });
  await target.inject({ method: "POST", url: `/api/v1/training/runs/${runId}/execute`, headers: auth(ADMIN_ID), payload: {} });
  const candidate = (await target.inject({ method: "GET", url: "/api/v1/models/candidates", headers: auth(ADMIN_ID) })).json().data[0];
  const artifact = (await target.inject({ method: "GET", url: `/api/v1/training/runs/${runId}/artifacts`, headers: auth(ADMIN_ID) })).json().data[0];
  return { runId, candidateId: candidate.id as string, trainableModelId: registered.json().checkpoint.id as string, adapterSha: artifact.sha256 as string };
}
