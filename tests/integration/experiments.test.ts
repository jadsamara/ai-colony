import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ID, auth, createTestApp } from "../helpers/app.js";
import { seed } from "@ai-colony/database";
import { testDb } from "../helpers/db.js";

const WEIGHT = "00000000-0000-4000-8000-000000000208";
const MONITORING = "00000000-0000-4000-8000-000000000203";
const MATH = "00000000-0000-4000-8000-000000000204";

const record = {
  idempotencyKey: "m75b-record-001",
  methodId: "lora-supervised",
  modelId: "Qwen/Qwen3-1.7B-MLX-4bit",
  modelRevision: "21457c6f51ed54a7c16e988c0844db973815c137",
  adapterSha256: "a".repeat(64),
  problem: "asm3-30 development diagnostic",
  datasetSize: 25,
  learningRate: 0.00001,
  steps: 5,
  target: "answer",
  seed: 101,
  devAccuracy: 0.4,
  baselineAccuracy: 0.45,
  sealedAccuracy: null,
  retentionOk: true,
  failureClass: null,
  recommendation: "Keep the adapter experimental.",
  evidencePath: "services/training/results/m75b/training/example.json",
};

describe("weight optimization experiments", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await seed(testDb());
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps planning inside Weight Optimization and does not promote", async () => {
    const methods = await app.inject({ method: "GET", url: "/api/v1/training/methods", headers: auth(WEIGHT) });
    expect(methods.statusCode).toBe(200);
    expect(methods.json().methods.find((method: { id: string }) => method.id === "reinforcement-learning").status).toBe("unsupported");

    const denied = await app.inject({ method: "POST", url: "/api/v1/training/experiments/plan", headers: auth(MATH), payload: { problem: "arithmetic", baseAccuracy: 0.45, budgetMaxSteps: 40 } });
    expect(denied.statusCode).toBe(403);

    const historical = await app.inject({
      method: "POST",
      url: "/api/v1/training/experiments",
      headers: auth(WEIGHT),
      payload: { ...record, idempotencyKey: "m75-historical-80", steps: 80, learningRate: 0.0001, devAccuracy: 0.09, baselineAccuracy: 0.45, sealedAccuracy: 0.09, failureClass: "regression", recommendation: "Do not repeat this configuration." },
    });
    expect(historical.statusCode).toBe(201);
    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/training/experiments",
      headers: auth(WEIGHT),
      payload: { ...record, idempotencyKey: "m75-historical-80", steps: 80, learningRate: 0.0001, devAccuracy: 0.09, baselineAccuracy: 0.45, sealedAccuracy: 0.09, failureClass: "regression", recommendation: "Do not repeat this configuration." },
    });
    expect(repeated.json().repeated).toBe(true);
    expect(repeated.json().experiment.id).toBe(historical.json().experiment.id);

    const plan = await app.inject({ method: "POST", url: "/api/v1/training/experiments/plan", headers: auth(WEIGHT), payload: { problem: "arithmetic", baseAccuracy: 0.45, budgetMaxSteps: 40 } });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().recommendations.find((item: { action: string }) => item.action === "reject-configuration").citedExperimentIds).toContain(historical.json().experiment.id);
    expect(plan.json().recommendations.every((item: { deployment: string }) => item.deployment === "ineligible")).toBe(true);

    const promoted = await app.inject({ method: "POST", url: "/api/v1/training/experiments", headers: auth(WEIGHT), payload: { ...record, idempotencyKey: "m75b-promote", recommendation: "Promote the adapter" } });
    expect(promoted.statusCode).toBe(403);
    const candidates = await app.inject({ method: "GET", url: "/api/v1/models/candidates", headers: auth(ADMIN_ID) });
    expect(candidates.json().data.find((candidate: { id: string }) => candidate.id === repeated.json().experiment.id)).toBeUndefined();
  });

  it("lets monitoring stop a regression and refuses a healthy run", async () => {
    const weightStop = await app.inject({
      method: "POST",
      url: "/api/v1/training/experiments/stop",
      headers: auth(WEIGHT),
      payload: { ...record, idempotencyKey: "m75b-stop-weight", peakMemoryBytes: 1000, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true, devAccuracy: 0.1 },
    });
    expect(weightStop.statusCode).toBe(403);
    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/training/experiments/stop",
      headers: auth(MONITORING),
      payload: { ...record, idempotencyKey: "m75b-stop-regression", peakMemoryBytes: 1000, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true, devAccuracy: 0.1, baselineAccuracy: 0.5 },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().experiment.stopped).toBe(true);
    expect(stopped.json().reason).toMatch(/regressed/);
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/training/experiments/stop",
      headers: auth(MONITORING),
      payload: { ...record, idempotencyKey: "m75b-stop-regression", peakMemoryBytes: 1000, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true, devAccuracy: 0.1, baselineAccuracy: 0.5 },
    });
    expect(again.json().experiment.id).toBe(stopped.json().experiment.id);
    const healthy = await app.inject({
      method: "POST",
      url: "/api/v1/training/experiments/stop",
      headers: auth(MONITORING),
      payload: { ...record, idempotencyKey: "m75b-stop-healthy", peakMemoryBytes: 1000, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true },
    });
    expect(healthy.statusCode).toBe(409);
  });
});
