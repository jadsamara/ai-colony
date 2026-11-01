import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMMA3_270M_MODEL_ID } from "@ai-colony/contracts";
import { ScriptedTrainingProvider } from "@ai-colony/core";
import { seed } from "@ai-colony/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ID, auth, createTestApp } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";

const MATH = "00000000-0000-4000-8000-000000000204";
const MATH_DEPT = "00000000-0000-4000-8000-000000000019";
const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPT = "00000000-0000-4000-8000-00000000001b";
const RESEARCH = "00000000-0000-4000-8000-000000000206";
const WEIGHT = "00000000-0000-4000-8000-000000000208";
const EVAL = "00000000-0000-4000-8000-000000000209";
const MEMORY = "00000000-0000-4000-8000-000000000210";
const roots = { artifacts: mkdtempSync(join(tmpdir(), "colony-m7h-artifacts-")), checkpoints: mkdtempSync(join(tmpdir(), "colony-m7h-checkpoints-")) };
const checkpointPath = join(roots.checkpoints, "gemma-3-270m", "model.safetensors");
const checkpointSha = createHash("sha256").update("m7h-checkpoint").digest("hex");
const provider = new ScriptedTrainingProvider();

describe("learning hardening", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  const versions = new Map<string, string>();

  beforeAll(async () => {
    mkdirSync(join(roots.checkpoints, "gemma-3-270m"), { recursive: true });
    writeFileSync(checkpointPath, "m7h-checkpoint");
    app = await createTestApp({ trainingProvider: provider, trainingRoots: roots });
  });
  beforeEach(async () => {
    provider.fail = false;
    provider.failPredict = false;
    provider.beforeFinish = undefined;
    versions.clear();
    await seed(testDb());
  });
  afterAll(async () => {
    await app.close();
  });

  it("enforces budgets, cancellation, duplicate execution, and worker failure", async () => {
    const trainable = await register();
    const steps = await approvedCycle("budget-steps", trainable);
    const raised = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${steps}/budget`, headers: auth(MATH), payload: { maxTrainingSteps: 100 } });
    expect(raised.statusCode).toBe(403);
    const increase = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${steps}/budget`, headers: auth(ADMIN_ID), payload: { maxTrainingSteps: 80 } });
    expect(increase.statusCode).toBe(403);
    await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${steps}/budget`, headers: auth(ADMIN_ID), payload: { maxTrainingSteps: 0 } });
    const stepBlock = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${steps}/execute-training`, headers: auth(ADMIN_ID) });
    expect(stepBlock.statusCode).toBe(422);

    const runtime = await approvedCycle("budget-runtime", trainable);
    await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${runtime}/budget`, headers: auth(ADMIN_ID), payload: { maxRuntimeMs: 0 } });
    const runtimeBlock = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${runtime}/execute-training`, headers: auth(ADMIN_ID) });
    expect(runtimeBlock.statusCode).toBe(422);

    const early = await observedCycle("cancel-early");
    const cancelled = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${early}/cancel`, headers: auth(MATH), payload: { reason: "stop before training" } });
    expect(cancelled.json().status).toBe("CANCELLED");

    const waiting = await proposedCycle("cancel-waiting", trainable);
    const waitingCancel = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${waiting}/cancel`, headers: auth(ADMIN_ID), payload: { reason: "stop before approval" } });
    expect(waitingCancel.json().status).toBe("CANCELLED");

    const active = await approvedCycle("cancel-active", trainable);
    provider.beforeFinish = async () => {
      const interrupting = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${active}/cancel`, headers: auth(ADMIN_ID), payload: { reason: "interrupt before an adapter exists" } });
      expect(interrupting.statusCode).toBe(200);
    };
    const interrupted = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${active}/execute-training`, headers: auth(ADMIN_ID) });
    provider.beforeFinish = undefined;
    expect(interrupted.statusCode, interrupted.body).toBe(200);
    expect(interrupted.json().retrained).toBe(false);
    const activeView = await app.inject({ method: "GET", url: `/api/v1/learning/cycles/${active}`, headers: auth(ADMIN_ID) });
    expect(activeView.json().cycle.status).toBe("CANCELLED");

    const first = await approvedCycle("concurrent-a", trainable);
    const second = await approvedCycle("concurrent-b", trainable);
    provider.beforeFinish = async () => {
      const other = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${second}/execute-training`, headers: auth(ADMIN_ID) });
      expect(other.statusCode).toBe(409);
    };
    const ran = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${first}/execute-training`, headers: auth(ADMIN_ID) });
    provider.beforeFinish = undefined;
    expect(ran.json().retrained).toBe(true);
    const released = await app.inject({ method: "POST", url: `/api/v1/training/runs/${ran.json().run.id}/evaluate`, headers: auth(ADMIN_ID), payload: {} });
    expect(released.statusCode, released.body).toBe(200);

    const duplicate = await objectiveCycle("duplicate-request");
    const proposal = await propose(duplicate, trainable, "dup-data");
    const again = await propose(duplicate, trainable, "dup-data");
    expect(again.json().run.id).toBe(proposal.json().run.id);
    await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${duplicate}/approve-training`, headers: auth(ADMIN_ID) });
    const secondApproval = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${duplicate}/approve-training`, headers: auth(ADMIN_ID) });
    expect(secondApproval.statusCode).toBe(409);
    const resumed = await app.inject({ method: "GET", url: `/api/v1/learning/cycles/${duplicate}/resume`, headers: auth(MATH) });
    expect(resumed.json().next).toBe("execute");
    expect(resumed.json().executed).toBe(false);

    provider.fail = true;
    const failed = await approvedCycle("worker-failed", trainable);
    const failure = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${failed}/execute-training`, headers: auth(ADMIN_ID) });
    expect(failure.statusCode).toBe(422);
    const failedView = await app.inject({ method: "GET", url: `/api/v1/learning/cycles/${failed}`, headers: auth(ADMIN_ID) });
    expect(failedView.json().cycle.status).toBe("FAILED");
    const retry = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${failed}/execute-training`, headers: auth(ADMIN_ID) });
    expect(retry.json().retrained).toBe(false);
    expect(retry.json().run.id).toBe(failedView.json().cycle.trainingRunId);
    provider.fail = false;

    const evaluated = await approvedCycle("eval-failed", trainable);
    await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${evaluated}/execute-training`, headers: auth(ADMIN_ID) });
    provider.failPredict = true;
    const evalFailure = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${evaluated}/evaluate`, headers: auth(EVAL) });
    expect(evalFailure.statusCode).toBe(422);
    const afterEval = await app.inject({ method: "GET", url: `/api/v1/learning/cycles/${evaluated}`, headers: auth(ADMIN_ID) });
    expect(afterEval.json().cycle.status).toBe("FAILED");
    expect(afterEval.json().cycle.evaluationRunId).toBeNull();
    provider.failPredict = false;

    const inference = await approvedCycle("budget-inference", trainable);
    const trained = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${inference}/execute-training`, headers: auth(ADMIN_ID) });
    expect(trained.json().retrained).toBe(true);
    await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${inference}/budget`, headers: auth(ADMIN_ID), payload: { maxInferenceCalls: 0 } });
    const inferenceBlock = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${inference}/evaluate`, headers: auth(EVAL) });
    expect(inferenceBlock.statusCode).toBe(422);
  });

  it("keeps consultation, specialist, and joint memory inside their owners", async () => {
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/learning/collaborations/consultations",
      headers: auth(MATH),
      payload: { recipientDepartmentId: SCIENCE_DEPT, question: "MATH-PRIVATE-OBJECTIVE needs the gravitational constant", idempotencyKey: "consult-gravity", ttlMs: 60_000 },
    });
    expect(opened.statusCode).toBe(201);
    const contextId = opened.json().contextId as string;
    const visible = await app.inject({ method: "GET", url: `/api/v1/learning/collaborations/${contextId}`, headers: auth(SCIENCE) });
    expect(visible.json().entries[0].content).toContain("MATH-PRIVATE-OBJECTIVE");
    const outsider = await app.inject({ method: "GET", url: `/api/v1/learning/collaborations/${contextId}`, headers: auth(RESEARCH) });
    expect(outsider.statusCode).toBe(403);
    const scienceBefore = await search(SCIENCE, "MATH-PRIVATE-OBJECTIVE");
    expect(scienceBefore.json().hits ?? scienceBefore.json().data ?? []).toHaveLength(0);
    const answer = await app.inject({
      method: "POST",
      url: `/api/v1/learning/collaborations/${contextId}/entries`,
      headers: auth(SCIENCE),
      payload: { content: "G=6.67430e-11", kind: "answer", provenance: "user_provided", idempotencyKey: "consult-answer", relevantToRecipientDomain: true },
    });
    const retained = await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/entries/${answer.json().id}/retain`, headers: auth(MATH) });
    expect(retained.statusCode).toBe(201);
    expect(retained.json().provenance).toBe("user_provided");
    const scienceAfter = await search(SCIENCE, "MATH-PRIVATE-OBJECTIVE");
    expect(scienceAfter.json().hits).toHaveLength(0);
    const mathMemory = await app.inject({ method: "GET", url: `/api/v1/memories/${retained.json().memoryId}`, headers: auth(MATH) });
    const scienceMemory = await app.inject({ method: "GET", url: `/api/v1/memories/${retained.json().memoryId}`, headers: auth(SCIENCE) });
    expect(mathMemory.statusCode).toBe(200);
    expect(scienceMemory.statusCode).toBe(404);
    await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/${contextId}/close`, headers: auth(MATH) });
    const expired = await app.inject({ method: "GET", url: `/api/v1/learning/collaborations/${contextId}`, headers: auth(SCIENCE) });
    expect(expired.json().entries.every((entry: { content: string }) => entry.content === "")).toBe(true);

    const specialist = await app.inject({
      method: "POST",
      url: "/api/v1/learning/collaborations/specialist",
      headers: auth(MATH),
      payload: { recipientDepartmentId: SCIENCE_DEPT, question: "MATH-PRIVATE-CALCULATION orbital setup", idempotencyKey: "specialist-orbit" },
    });
    await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/${specialist.json().contextId}/accept`, headers: auth(SCIENCE) });
    const privatePromote = await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/entries/${specialist.json().entryId}/promote`, headers: auth(SCIENCE), payload: { relevantToRecipientDomain: true } });
    expect(privatePromote.statusCode).toBe(422);
    const contribution = await app.inject({
      method: "POST",
      url: `/api/v1/learning/collaborations/${specialist.json().contextId}/entries`,
      headers: auth(SCIENCE),
      payload: { content: "SCIENCE-CONSTANT local gravitational parameter", kind: "contribution", provenance: "user_provided", idempotencyKey: "specialist-fact", relevantToRecipientDomain: true },
    });
    const promoted = await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/entries/${contribution.json().id}/promote`, headers: auth(SCIENCE), payload: { relevantToRecipientDomain: true } });
    expect(promoted.statusCode).toBe(200);
    const unrelated = await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/entries/${contribution.json().id}/promote`, headers: auth(MATH), payload: { relevantToRecipientDomain: false } });
    expect(unrelated.statusCode).toBe(422);

    const joint = await app.inject({
      method: "POST",
      url: "/api/v1/learning/collaborations/joint",
      headers: auth(MATH),
      payload: { recipientDepartmentId: SCIENCE_DEPT, purpose: "shared orbital calculation", idempotencyKey: "joint-orbit" },
    });
    const tooSoon = await app.inject({
      method: "POST",
      url: `/api/v1/learning/collaborations/${joint.json().contextId}/entries`,
      headers: auth(MATH),
      payload: { content: "shared assumption", kind: "shared_decision", provenance: "user_provided", idempotencyKey: "joint-early", relevantToRecipientDomain: true },
    });
    expect(tooSoon.statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/${joint.json().contextId}/accept`, headers: auth(SCIENCE) });
    const shared = await app.inject({
      method: "POST",
      url: `/api/v1/learning/collaborations/${joint.json().contextId}/entries`,
      headers: auth(MATH),
      payload: { content: "JOINT-MU-3.986e14", kind: "shared_decision", provenance: "user_provided", idempotencyKey: "joint-mu", relevantToRecipientDomain: true },
    });
    const scienceJoint = await app.inject({ method: "GET", url: `/api/v1/learning/collaborations/${joint.json().contextId}`, headers: auth(SCIENCE) });
    expect(scienceJoint.json().entries.some((entry: { content: string }) => entry.content.includes("JOINT-MU"))).toBe(true);
    const researchJoint = await app.inject({ method: "GET", url: `/api/v1/learning/collaborations/${joint.json().contextId}`, headers: auth(RESEARCH) });
    expect(researchJoint.statusCode).toBe(403);
    const kept = await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/entries/${shared.json().id}/promote`, headers: auth(SCIENCE), payload: { relevantToRecipientDomain: true } });
    expect(kept.statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/api/v1/learning/collaborations/${joint.json().contextId}/close`, headers: auth(MATH) });
    const closed = await app.inject({ method: "GET", url: `/api/v1/learning/collaborations/${joint.json().contextId}`, headers: auth(SCIENCE) });
    expect(closed.json().status).toBe("closed");
    expect(closed.json().entries.every((entry: { content: string }) => entry.content === "")).toBe(true);

    const source = await app.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: auth(RESEARCH),
      payload: { scope: "department", category: "semantic", title: "fact", summary: "forget me", content: "FORGET-THIS-FACT", provenance: "user_provided", idempotencyKey: "forget-fact" },
    });
    const transfer = await app.inject({
      method: "POST",
      url: "/api/v1/learning/transfers",
      headers: auth(RESEARCH),
      payload: { destinationDepartmentId: SCIENCE_DEPT, sourceMemoryId: source.json().memory.id, idempotencyKey: "forget-transfer" },
    });
    const request = await app.inject({ method: "POST", url: "/api/v1/memory/forgetting-requests", headers: auth(MEMORY), payload: { memoryId: source.json().memory.id, idempotencyKey: "forget-request" } });
    expect(request.statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/api/v1/memory/forgetting-requests/${request.json().id}/approve`, headers: auth(ADMIN_ID) });
    await app.inject({ method: "POST", url: `/api/v1/memory/forgetting-requests/${request.json().id}/execute`, headers: auth(ADMIN_ID) });
    const replay = await app.inject({ method: "POST", url: `/api/v1/learning/transfers/${transfer.json().id}/validate`, headers: auth(SCIENCE), payload: { decision: "accept", reason: "try the old transfer" } });
    expect(replay.json().decision).toBe("reject");
    expect(replay.json().acceptedMemoryId).toBeNull();

    const sweepDenied = await app.inject({ method: "POST", url: "/api/v1/learning/retention/sweep", headers: auth(MATH) });
    expect(sweepDenied.statusCode).toBe(403);
    const sweep = await app.inject({ method: "POST", url: "/api/v1/learning/retention/sweep", headers: auth(MEMORY) });
    expect(sweep.statusCode).toBe(200);
    const report = await app.inject({ method: "GET", url: "/api/v1/learning/retention/report", headers: auth(MEMORY) });
    expect(JSON.stringify(report.json())).not.toContain("MATH-PRIVATE-OBJECTIVE");
  });

  async function register(): Promise<string> {
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/models/checkpoints",
      headers: auth(ADMIN_ID),
      payload: { registryModelId: GEMMA3_270M_MODEL_ID, checkpointPath, expectedSha256: checkpointSha, source: "local-gemma-fixture", revision: "test", tokenizerId: "gemma", precision: "bf16", architecture: "gemma3_text", framework: "mlx-lm", frameworkVersion: "test", license: "gemma", contextLength: 32768 },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    return registered.json().checkpoint.id as string;
  }

  async function observedCycle(category: string): Promise<string> {
    const versionId = await benchmark(category);
    const gap = await app.inject({ method: "POST", url: "/api/v1/learning/gaps", headers: auth(MATH), payload: { departmentId: MATH_DEPT, taskCategory: category, evidenceKind: "evaluation", evidenceRefs: [versionId], failureCount: 2, severity: "high", impact: category, proposedMethod: "lora" } });
    expect(gap.statusCode, gap.body).toBe(201);
    return gap.json().cycle.id as string;
  }

  async function objectiveCycle(category: string): Promise<string> {
    const versionId = await benchmark(category);
    const gap = await app.inject({ method: "POST", url: "/api/v1/learning/gaps", headers: auth(MATH), payload: { departmentId: MATH_DEPT, taskCategory: category, evidenceKind: "evaluation", evidenceRefs: [versionId], failureCount: 2, severity: "high", impact: category, proposedMethod: "lora" } });
    expect(gap.statusCode, gap.body).toBe(201);
    await app.inject({ method: "POST", url: `/api/v1/learning/gaps/${gap.json().gap.id}/validate`, headers: auth(MATH) });
    const objective = await app.inject({ method: "POST", url: `/api/v1/learning/gaps/${gap.json().gap.id}/objectives`, headers: auth(MATH), payload: { weakness: category, benchmarkVersionId: versionId } });
    expect(objective.statusCode, objective.body).toBe(201);
    return objective.json().cycleId as string;
  }

  async function proposedCycle(category: string, trainable: string): Promise<string> {
    const cycleId = await objectiveCycle(category);
    const proposed = await propose(cycleId, trainable, `${category}-data`);
    expect(proposed.statusCode, proposed.body).toBe(201);
    return cycleId;
  }

  async function approvedCycle(category: string, trainable: string): Promise<string> {
    const cycleId = await proposedCycle(category, trainable);
    const approved = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/approve-training`, headers: auth(ADMIN_ID) });
    expect(approved.statusCode, approved.body).toBe(200);
    return cycleId;
  }

  function propose(cycleId: string, trainable: string, key: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/learning/cycles/${cycleId}/training-proposal`,
      headers: auth(WEIGHT),
      payload: { name: key, taskDomain: "structured-arithmetic", source: "curated_arithmetic", exampleCount: 48, seed: 11, idempotencyKey: key, trainableModelId: trainable },
    });
  }

  async function benchmark(category: string): Promise<string> {
    const cached = versions.get(category);
    if (cached) {
      return cached;
    }
    const suite = await app.inject({ method: "POST", url: "/api/v1/evaluations/suites", headers: auth(EVAL), payload: { slug: category, name: category } });
    expect(suite.statusCode, suite.body).toBe(201);
    const version = await app.inject({
      method: "POST",
      url: `/api/v1/evaluations/suites/${suite.json().id}/versions`,
      headers: auth(EVAL),
      payload: { description: category, domain: "arithmetic", source: "m7h", license: "internal", protocol: "greedy", sealed: true, items: [1, 2, 3, 4, 5].map((n) => ({ prompt: `41 + ${n}`, expected: String(41 + n) })) },
    });
    expect(version.statusCode, version.body).toBe(201);
    const published = await app.inject({ method: "POST", url: `/api/v1/evaluations/versions/${version.json().id}/publish`, headers: auth(ADMIN_ID) });
    expect(published.statusCode, published.body).toBe(200);
    versions.set(category, version.json().id as string);
    return version.json().id as string;
  }

  function search(actor: string, query: string) {
    return app.inject({ method: "POST", url: "/api/v1/memories/search", headers: auth(actor), payload: { query, statuses: ["candidate", "validated"] } });
  }
});
