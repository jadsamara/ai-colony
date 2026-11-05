import { readFileSync } from "node:fs";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import {
  LEGACY_DEPARTMENT_IDS,
  SHARED_QWEN3_8B_MODEL_ID,
  evaluateRouting,
  isLegacyDepartment,
  type RoutingSnapshot,
} from "@ai-colony/core";
import { describe, expect, it } from "vitest";

const ENGINEERING_ID = "123e24dc-c194-43e0-91a7-c4df153e5030";
const MATH_ID = "00000000-0000-4000-8000-000000000019";
const SCIENCE_ID = "00000000-0000-4000-8000-00000000001b";

const CANONICAL_DEPARTMENTS = [
  ["00000000-0000-4000-8000-000000000011", "CEO", "ceo", "active"],
  ["00000000-0000-4000-8000-000000000012", "Orchestration", "orchestration", "active"],
  ["00000000-0000-4000-8000-000000000013", "Monitoring", "monitoring", "active"],
  ["00000000-0000-4000-8000-000000000014", "Evolution", "evolution", "active"],
  ["00000000-0000-4000-8000-000000000015", "Weight Optimization", "weight-optimization", "active"],
  ["00000000-0000-4000-8000-000000000016", "Memory & Forgetting", "memory-and-forgetting", "active"],
  ["00000000-0000-4000-8000-000000000017", "Evaluation", "evaluation", "active"],
  ["00000000-0000-4000-8000-000000000018", "Research", "research", "active"],
  [MATH_ID, "Math", "math", "active"],
  ["00000000-0000-4000-8000-00000000001a", "Reasoning", "reasoning", "active"],
  [SCIENCE_ID, "Science", "science", "active"],
  ["00000000-0000-4000-8000-00000000001c", "Gaming", "gaming", "archived"],
  ["00000000-0000-4000-8000-00000000001d", "Product", "product", "active"],
  [ENGINEERING_ID, "Engineering", "engineering", "proposed"],
] as const;

describe("legacy department allowlist", () => {
  it("uses stable department ids from the seed, not names or row order", () => {
    const seed = readFileSync("packages/database/src/seed.ts", "utf8");
    const block = seed.slice(seed.indexOf("const INITIAL_DEPARTMENTS"), seed.indexOf("const INITIAL_MODELS"));
    const ids = [...block.matchAll(/00000000-0000-4000-8000-00000000001[0-9a-f]/g)].map((match) => match[0]);
    expect([...LEGACY_DEPARTMENT_IDS]).toEqual(ids);
    expect(LEGACY_DEPARTMENT_IDS).not.toContain("ceo");
    expect(isLegacyDepartment(ENGINEERING_ID)).toBe(false);
  });

  it("authorizes every active seeded department and excludes proposed engineering", () => {
    for (const [id, , , status] of CANONICAL_DEPARTMENTS) {
      const decision = evaluateRouting(snapshot(id, status, id === MATH_ID || id === SCIENCE_ID));
      if (status === "active") {
        expect(decision.authorization).toBe("authorized");
        expect(decision.registryModelId).toBe(SHARED_QWEN3_8B_MODEL_ID);
        expect(decision.servingModel).toBe("qwen3:8b");
      } else {
        expect(decision.authorization).toBe("denied");
        expect(decision.reasonCode).toBe("department_inactive");
      }
    }
  });

  it("lets an explicit rejection override the compatibility default", () => {
    const decision = evaluateRouting({
      ...snapshot(CANONICAL_DEPARTMENTS[0][0], "active", false),
      assignments: [{
        id: "00000000-0000-4000-8000-000000000301",
        departmentId: CANONICAL_DEPARTMENTS[0][0],
        role: "shared_base",
        registryModelId: QWEN3_8B_MODEL_ID,
        adapterSha256: null,
        modelFamily: "qwen3",
        version: 1,
        status: "rejected",
      }],
    });
    expect(isLegacyDepartment(CANONICAL_DEPARTMENTS[0][0])).toBe(true);
    expect(decision.reasonCode).toBe("disabled_assignment");
    expect(decision.authorization).toBe("denied");
  });
});

function snapshot(departmentId: string, status: string, assigned: boolean): RoutingSnapshot {
  return {
    departmentId,
    departmentStatus: status,
    agentDepartmentId: null,
    assignments: assigned
      ? [{
          id: "00000000-0000-4000-8000-000000000302",
          departmentId,
          role: "shared_base",
          registryModelId: QWEN3_8B_MODEL_ID,
          adapterSha256: null,
          modelFamily: "qwen3",
          version: 1,
          status: "active",
        }]
      : [],
    models: {
      [QWEN3_8B_MODEL_ID]: {
        id: QWEN3_8B_MODEL_ID,
        status: "not_deployed",
        modelFamily: "qwen3",
        displayName: "Qwen3-8B",
      },
    },
    requestedModelId: null,
    sharedServingTag: "qwen3:8b",
    derived: null,
    evidence: {
      state: "readiness_unknown",
      capturedAt: null,
      digest: null,
      servingTag: null,
      artifactBytes: null,
      loadedCount: null,
    },
    now: "2026-11-03T04:00:00.000Z",
    budgetAllowed: true,
    resourceAllowed: true,
    memoryKnown: false,
    servingBackend: "ollama",
    certifiedCapabilityCount: 0,
    syntheticCapabilityCount: 0,
    executionDigest: null,
  };
}
