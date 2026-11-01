import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMMA3_270M_MODEL_ID, QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
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
const roots = { artifacts: mkdtempSync(join(tmpdir(), "colony-m7-artifacts-")), checkpoints: mkdtempSync(join(tmpdir(), "colony-m7-checkpoints-")) };
const checkpointPath = join(roots.checkpoints, "gemma-3-270m", "model.safetensors");
const checkpointSha = createHash("sha256").update("m7-checkpoint").digest("hex");

describe("department learning", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    mkdirSync(join(roots.checkpoints, "gemma-3-270m"), { recursive: true });
    writeFileSync(checkpointPath, "m7-checkpoint");
    app = await createTestApp({ trainingRoots: roots });
  });
  beforeEach(async () => {
    await seed(testDb());
  });
  afterAll(async () => {
    await app.close();
  });

  it("keeps training behind approval and does not adopt an inconclusive candidate", async () => {
    const qwenBefore = await app.inject({ method: "GET", url: `/api/v1/models/${QWEN3_8B_MODEL_ID}`, headers: auth(ADMIN_ID) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/models/checkpoints",
      headers: auth(ADMIN_ID),
      payload: { registryModelId: GEMMA3_270M_MODEL_ID, checkpointPath, expectedSha256: checkpointSha, source: "local-gemma-fixture", revision: "test", tokenizerId: "gemma", precision: "bf16", architecture: "gemma3_text", framework: "mlx-lm", frameworkVersion: "test",       license: "gemma", contextLength: 32768 },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const suite = await app.inject({ method: "POST", url: "/api/v1/evaluations/suites", headers: auth(EVAL), payload: { slug: "m7-holdout", name: "M7 holdout" } });
    const version = await app.inject({
      method: "POST",
      url: `/api/v1/evaluations/suites/${suite.json().id}/versions`,
      headers: auth(EVAL),
      payload: { description: "disjoint holdout", domain: "arithmetic", source: "m7", license: "internal", protocol: "greedy", sealed: true, items: [1, 2, 3, 4, 5].map((n) => ({ prompt: `40 + ${n}`, expected: String(40 + n) })) },
    });
    await app.inject({ method: "POST", url: `/api/v1/evaluations/versions/${version.json().id}/publish`, headers: auth(ADMIN_ID) });
    const hidden = await app.inject({ method: "GET", url: `/api/v1/evaluations/versions/${version.json().id}`, headers: auth(MATH) });
    expect(hidden.json().items).toEqual([]);
    const gap = await app.inject({
      method: "POST",
      url: "/api/v1/learning/gaps",
      headers: auth(MATH),
      payload: { departmentId: MATH_DEPT, taskCategory: "arithmetic", evidenceKind: "evaluation", evidenceRefs: [version.json().id], failureCount: 2, severity: "high", impact: "held-out addition misses", proposedMethod: "lora" },
    });
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/learning/gaps",
      headers: auth(MATH),
      payload: { departmentId: MATH_DEPT, taskCategory: "arithmetic", evidenceKind: "evaluation", evidenceRefs: [version.json().id], failureCount: 1, severity: "high", impact: "repeat", proposedMethod: "lora" },
    });
    expect(again.json().aggregated).toBe(true);
    expect(again.json().gap.failureCount).toBe(3);
    const subjective = await app.inject({ method: "POST", url: "/api/v1/learning/gaps", headers: auth(MATH), payload: { departmentId: MATH_DEPT, taskCategory: "arithmetic", evidenceKind: "self_report", evidenceRefs: [version.json().id], failureCount: 2, severity: "low", impact: "felt weak", proposedMethod: "lora" } });
    expect(subjective.statusCode).toBe(400);
    await app.inject({ method: "POST", url: `/api/v1/learning/gaps/${gap.json().gap.id}/validate`, headers: auth(MATH) });
    const objective = await app.inject({ method: "POST", url: `/api/v1/learning/gaps/${gap.json().gap.id}/objectives`, headers: auth(MATH), payload: { weakness: "addition holdout", benchmarkVersionId: version.json().id } });
    expect(objective.json().mechanism).toBe("lora");
    const cycleId = objective.json().cycleId as string;
    const blocked = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/execute-training`, headers: auth(ADMIN_ID) });
    expect(blocked.statusCode).toBe(409);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/learning/cycles/${cycleId}/training-proposal`,
      headers: auth(MATH),
      payload: { name: "m7", taskDomain: "structured-arithmetic", source: "curated_arithmetic", exampleCount: 48, seed: 11, idempotencyKey: "m7-data-math", trainableModelId: registered.json().checkpoint.id },
    });
    expect(denied.statusCode).toBe(403);
    const proposed = await app.inject({
      method: "POST",
      url: `/api/v1/learning/cycles/${cycleId}/training-proposal`,
      headers: auth(WEIGHT),
      payload: { name: "m7", taskDomain: "structured-arithmetic", source: "curated_arithmetic", exampleCount: 48, seed: 11, idempotencyKey: "m7-data-weight", trainableModelId: registered.json().checkpoint.id },
    });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().run.status).toBe("awaiting_approval");
    const resumed = await app.inject({ method: "GET", url: `/api/v1/learning/cycles/${cycleId}/resume`, headers: auth(ADMIN_ID) });
    expect(resumed.json().next).toBe("approve");
    expect(resumed.json().executed).toBe(false);
    await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/approve-training`, headers: auth(ADMIN_ID) });
    const executed = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/execute-training`, headers: auth(ADMIN_ID) });
    expect(executed.json().retrained).toBe(true);
    const repeat = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/execute-training`, headers: auth(ADMIN_ID) });
    expect(repeat.json().retrained).toBe(false);
    const mathEval = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/evaluate`, headers: auth(MATH) });
    expect(mathEval.statusCode).toBe(403);
    const evaluated = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/evaluate`, headers: auth(EVAL) });
    expect(evaluated.statusCode).toBe(200);
    const gate = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/gate`, headers: auth(ADMIN_ID) });
    expect(gate.json().decision).toBe("INCONCLUSIVE");
    const adopted = await app.inject({ method: "POST", url: `/api/v1/learning/cycles/${cycleId}/adopt`, headers: auth(ADMIN_ID) });
    expect(adopted.statusCode).toBe(409);
    const qwenAfter = await app.inject({ method: "GET", url: `/api/v1/models/${QWEN3_8B_MODEL_ID}`, headers: auth(ADMIN_ID) });
    expect(qwenAfter.json().model).toMatchObject(qwenBefore.json().model);
  });

  it("transfers verified knowledge, rejects unverified knowledge, and enforces department tools", async () => {
    const memory = await app.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: auth(RESEARCH),
      payload: { scope: "agent", category: "semantic", title: "water", summary: "verified boiling point", content: "M7-VERIFIED-FACT water boils at 100 C at 1 atm", provenance: "user_provided", idempotencyKey: "m7-fact-1" },
    });
    const transfer = await app.inject({
      method: "POST",
      url: "/api/v1/learning/transfers",
      headers: auth(RESEARCH),
      payload: { destinationDepartmentId: SCIENCE_DEPT, sourceMemoryId: memory.json().memory.id, idempotencyKey: "m7-transfer-1" },
    });
    expect(transfer.statusCode).toBe(201);
    const outsider = await app.inject({ method: "POST", url: `/api/v1/learning/transfers/${transfer.json().id}/validate`, headers: auth(MATH), payload: { decision: "accept", reason: "math wants it" } });
    expect(outsider.statusCode).toBe(403);
    const accepted = await app.inject({ method: "POST", url: `/api/v1/learning/transfers/${transfer.json().id}/validate`, headers: auth(SCIENCE), payload: { decision: "accept", reason: "source is user provided" } });
    expect(accepted.json().decision).toBe("accept");
    const found = await app.inject({ method: "POST", url: "/api/v1/memories/search", headers: auth(SCIENCE), payload: { query: "M7-VERIFIED-FACT", scopes: ["department"], topK: 5 } });
    expect(found.json().hits.some((hit: { id: string }) => hit.id === accepted.json().acceptedMemoryId)).toBe(true);
    const generated = await app.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: auth(RESEARCH),
      payload: { scope: "agent", category: "semantic", title: "guess", summary: "model guess", content: "M7-UNVERIFIED", provenance: "model_generated", idempotencyKey: "m7-guess-1" },
    });
    const rejectedTransfer = await app.inject({
      method: "POST",
      url: "/api/v1/learning/transfers",
      headers: auth(RESEARCH),
      payload: { destinationDepartmentId: SCIENCE_DEPT, sourceMemoryId: generated.json().memory.id, idempotencyKey: "m7-transfer-bad" },
    });
    expect(rejectedTransfer.statusCode).toBe(422);
    const registered = await app.inject({ method: "POST", url: "/api/v1/learning/capabilities", headers: auth(MATH), payload: { departmentId: MATH_DEPT, slug: "addition", domain: "arithmetic", taskType: "addition", description: "exact addition", tools: ["exact_arithmetic"] } });
    await app.inject({ method: "POST", url: `/api/v1/learning/capabilities/${registered.json().capability.id}/versions/${registered.json().version.id}/approve`, headers: auth(ADMIN_ID) });
    const mathTool = await app.inject({ method: "POST", url: `/api/v1/learning/departments/${MATH_DEPT}/tools`, headers: auth(MATH), payload: { tool: "exact_arithmetic", input: "2 + 2" } });
    expect(mathTool.json().output).toBe("4");
    const scienceTool = await app.inject({ method: "POST", url: `/api/v1/learning/departments/${MATH_DEPT}/tools`, headers: auth(SCIENCE), payload: { tool: "exact_arithmetic", input: "2 + 2" } });
    expect(scienceTool.statusCode).toBe(403);
    const ownScience = await app.inject({ method: "POST", url: `/api/v1/learning/departments/${SCIENCE_DEPT}/tools`, headers: auth(SCIENCE), payload: { tool: "exact_arithmetic", input: "2 + 2" } });
    expect(ownScience.statusCode).toBe(403);
    const assignment = await app.inject({ method: "POST", url: "/api/v1/learning/assignments", headers: auth(ADMIN_ID), payload: { departmentId: MATH_DEPT, role: "shared_base", registryModelId: QWEN3_8B_MODEL_ID } });
    expect(assignment.json().modelFamily).toBe("qwen3");
    expect(assignment.json().candidateId).toBeNull();
    const incompatible = await app.inject({ method: "POST", url: "/api/v1/learning/assignments", headers: auth(ADMIN_ID), payload: { departmentId: MATH_DEPT, role: "experimental_adapter", registryModelId: QWEN3_8B_MODEL_ID, candidateId: "4c67ce90-ad8c-4b9b-9994-2a9454e915d7" } });
    expect(incompatible.statusCode).toBe(409);
    const overview = await app.inject({ method: "GET", url: "/api/v1/learning/overview", headers: auth(ADMIN_ID) });
    expect(overview.json().cycles).toBeGreaterThan(0);
    const forget = await app.inject({ method: "POST", url: "/api/v1/learning/forgetting-proposals", headers: auth(MATH), payload: { memoryId: memory.json().memory.id, idempotencyKey: "m7-forget-denied" } });
    expect(forget.statusCode).toBe(403);
    const memoryProposal = await app.inject({ method: "POST", url: "/api/v1/learning/forgetting-proposals", headers: auth(MEMORY), payload: { memoryId: accepted.json().acceptedMemoryId, idempotencyKey: "m7-forget-ok" } });
    expect(memoryProposal.statusCode).toBe(201);
  });
});
