import { QWEN3_8B_MODEL_ID, type Actor, type ObjectivePlan } from "@ai-colony/contracts";
import {
  EVALUATION_DEPARTMENT_ID,
  GAMING_DEPARTMENT_ID,
  GAMING_SERVING_INSTANCE_ID,
  ImprovementService,
  PRODUCT_AGENT_ID,
  PRODUCT_DEPARTMENT_ID,
  PRODUCT_ENDPOINT_REFERENCE,
  PRODUCT_MOCK_ENDPOINT,
  PRODUCT_REAL_ENDPOINT,
  PRODUCT_SERVING_INSTANCE_ID,
  ROLE_PERMISSIONS,
  buildProposal,
  createMemoryImprovementStore,
  departmentProfiles,
  evaluateRouting,
  inventoryDepartmentStatus,
  planDedicatedInstances,
  planErrors,
  recommendParticipants,
  type ColonySignal,
  type RoutingSnapshot,
} from "@ai-colony/core";
import { SEED_AGENTS, SEED_DEPARTMENTS } from "@ai-colony/database";
import { describe, expect, it } from "vitest";

const ACTIVE = [
  "ceo",
  "orchestration",
  "monitoring",
  "evolution",
  "weight-optimization",
  "memory-and-forgetting",
  "evaluation",
  "research",
  "math",
  "reasoning",
  "science",
  "product",
];

function actor(role: Actor["role"], principalId: string, agentId: string | null, departmentId: string | null): Actor {
  return {
    principalId,
    principalType: agentId ? "agent" : "system",
    role,
    agentId,
    departmentId,
    permissions: [],
  };
}

const product = actor("department_agent", PRODUCT_AGENT_ID, PRODUCT_AGENT_ID, PRODUCT_DEPARTMENT_ID);
const ceo = actor("ceo_agent", "00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000011");
const orchestration = actor("orchestration_agent", "00000000-0000-4000-8000-000000000202", "00000000-0000-4000-8000-000000000202", "00000000-0000-4000-8000-000000000012");
const evaluation = actor("department_agent", "00000000-0000-4000-8000-000000000209", "00000000-0000-4000-8000-000000000209", EVALUATION_DEPARTMENT_ID);
const administrator = actor("system_administrator", "00000000-0000-4000-8000-000000000001", null, null);

const failure: ColonySignal = {
  source: "failure",
  summary: "Specialist tasks are failing before a result is returned",
  departmentSlug: "science",
};
const resource: ColonySignal = {
  source: "resource",
  summary: "GPU allocation is saturated",
  departmentSlug: null,
};
const missingDepartment: ColonySignal = {
  source: "capability",
  summary: "The colony is missing a department for hardware qualification",
  departmentSlug: null,
};

describe("M12.2 product department", () => {
  it("keeps twelve active departments, with Product replacing Gaming", () => {
    const departments = SEED_DEPARTMENTS.map(([id, name, slug, , purpose]) => ({
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
    expect(profiles).toHaveLength(12);
    expect(profiles.map((profile) => profile.slug)).toContain("product");
    expect(profiles.map((profile) => profile.slug)).not.toContain("gaming");
    expect(profiles.map((profile) => profile.slug)).not.toContain("engineering");
    const productProfile = profiles.find((profile) => profile.slug === "product");
    expect(productProfile).toMatchObject({
      departmentId: PRODUCT_DEPARTMENT_ID,
      agentId: PRODUCT_AGENT_ID,
      role: "department_agent",
    });
    expect(productProfile?.instructions).toMatch(/do not approve/i);
    const instances = planDedicatedInstances(profiles);
    expect(instances).toHaveLength(12);
    expect(new Set(instances.map((instance) => instance.endpointReference)).size).toBe(12);
    expect(instances.find((instance) => instance.departmentId === PRODUCT_DEPARTMENT_ID)).toMatchObject({
      instanceId: PRODUCT_SERVING_INSTANCE_ID,
      endpointReference: PRODUCT_ENDPOINT_REFERENCE,
      modelVersion: "qwen3-8b-base-v1",
    });
    expect(PRODUCT_SERVING_INSTANCE_ID).toBe("00000000-0000-4000-8000-00000000031d");
    expect(PRODUCT_SERVING_INSTANCE_ID).not.toBe(GAMING_SERVING_INSTANCE_ID);
    expect(PRODUCT_REAL_ENDPOINT).toBe("http://ollama-product:11434");
    expect(PRODUCT_MOCK_ENDPOINT).toBe("http://mock-product:8080");
  });

  it("refuses new work for archived Gaming and still recognizes its historical id", () => {
    const decision = evaluateRouting(routingSnapshot(GAMING_DEPARTMENT_ID, "archived"));
    expect(decision.authorization).toBe("denied");
    expect(decision.reasonCode).toBe("department_inactive");
    const errors = planErrors(
      {
        summary: "Do not assign retired work",
        tasks: [{
          localId: "old-game",
          departmentSlug: "gaming",
          taskType: "gaming",
          objective: "Play a turn",
          expectedOutput: "A score",
          dependsOn: [],
        }],
        completionCriteria: ["No new Gaming task"],
        estimatedResources: { inferenceRequests: 1, outputTokens: 16 },
        risks: [],
      } as unknown as ObjectivePlan,
      {
        activeDepartmentSlugs: new Set(ACTIVE.filter((slug) => slug !== "gaming")),
        staffedDepartmentSlugs: new Set(ACTIVE),
        maxInferenceRequests: 4,
        maxOutputTokens: 1000,
      },
    );
    expect(errors.join(" ")).toMatch(/gaming/);
  });

  it("selects participants from the evidence instead of one fixed set", () => {
    const fromFailure = recommendParticipants([failure], ACTIVE).map((item) => item.slug);
    const fromResource = recommendParticipants([resource], ACTIVE).map((item) => item.slug);
    const fromGap = recommendParticipants([missingDepartment], ACTIVE).map((item) => item.slug);
    const fromEmpty = recommendParticipants([], ACTIVE).map((item) => item.slug);
    expect(fromFailure).toEqual(["science", "monitoring", "reasoning", "orchestration"]);
    expect(fromResource).toEqual(["monitoring"]);
    expect(fromGap).toEqual(["research", "evolution", "orchestration"]);
    expect(fromEmpty).toEqual(["monitoring"]);
    for (const selected of [fromFailure, fromResource, fromGap, fromEmpty]) {
      expect(selected).not.toContain("gaming");
      expect(selected).not.toContain("engineering");
      expect(selected).not.toContain("product");
    }
    expect(new Set([fromFailure.join(), fromResource.join(), fromGap.join()]).size).toBe(3);
  });

  it("files a measurable proposal and enforces governance through evaluation", async () => {
    const service = new ImprovementService(createMemoryImprovementStore());
    const proposal = await service.propose(product, {
      problem: "Science tasks fail before producing a result.",
      signals: [failure],
      activeSlugs: ACTIVE,
      expectedBenefit: "Failed science tasks return a checked result.",
      estimatedCost: "One evaluation run and no new infrastructure.",
      risk: "The check could reject a valid science answer.",
      successCriteria: "Science task failure rate stays below 5% for 7 days.",
      dependencies: ["A current failure baseline"],
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.successCriteria).toMatch(/5%/);
    expect(proposal.participants.map((item) => item.slug)).toContain("science");
    expect(proposal.recommendsNewDepartment).toBe(false);
    await expect(service.propose(product, {
      problem: "Unmeasured",
      signals: [resource],
      activeSlugs: ACTIVE,
      expectedBenefit: "Lower cost",
      estimatedCost: "Small",
      risk: "Low",
      successCriteria: "It feels better",
    })).rejects.toThrow(/measurement/);

    const review = await service.submitForReview(product, proposal.id);
    expect(review.status).toBe("under_review");
    await expect(service.decide(product, proposal.id, "approved")).rejects.toThrow(/cannot approve/);
    const approved = await service.decide(ceo, proposal.id, "approved");
    expect(approved.createdDepartment).toBe(false);
    expect(approved.proposal.status).toBe("approved");
    await expect(service.dispatch(product, proposal.id)).rejects.toThrow(/Orchestration/);
    const dispatched = await service.dispatch(orchestration, proposal.id);
    expect(dispatched.proposal.status).toBe("in_progress");
    expect(dispatched.work.map((item) => item.departmentSlug)).toEqual(
      proposal.participants.map((item) => item.slug),
    );
    const evaluating = await service.requestEvaluation(product, proposal.id);
    expect(evaluating.status).toBe("evaluating");
    await expect(service.recordEvaluation(product, proposal.id, evidence(true, false))).rejects.toThrow(/successful/);
    const completed = await service.recordEvaluation(evaluation, proposal.id, evidence(true, false));
    expect(completed.status).toBe("completed");
    expect(completed.successful).toBe(true);
    expect(completed.recommendation).toBe("retain");
    const memory = service.memoryProposal(completed);
    expect(memory).toMatchObject({
      provenance: "model_generated",
      isFact: false,
      requiresPromotion: true,
      departmentSlug: "memory-and-forgetting",
    });

    const regressed = await evaluatedCopy(service, evidence(true, true));
    expect(regressed.recommendation).toBe("revise");
    expect(regressed.successful).toBe(false);
    const reverted = await evaluatedCopy(service, evidence(false, true));
    expect(reverted.recommendation).toBe("revert");
  });

  it("lets an administrator approve a department recommendation without creating one", async () => {
    const service = new ImprovementService(createMemoryImprovementStore());
    const proposal = await service.propose(product, {
      problem: "Hardware qualification has no owner.",
      signals: [missingDepartment],
      activeSlugs: ACTIVE,
      expectedBenefit: "The colony records the gap without adding a department.",
      estimatedCost: "A recommendation only.",
      risk: "A later administrator might mistake the recommendation for activation.",
      successCriteria: "0 departments are created by this proposal.",
    });
    expect(proposal.recommendsNewDepartment).toBe(true);
    expect(proposal.approvalRequirements.join(" ")).toMatch(/does not create/);
    await service.submitForReview(product, proposal.id);
    await expect(service.decide(ceo, proposal.id, "approved")).rejects.toThrow(/approval:decide:permanent/);
    const decided = await service.decide(administrator, proposal.id, "approved");
    expect(decided.createdDepartment).toBe(false);
    expect(decided.proposal.status).toBe("approved");
  });

  it("denies Product model promotion, deployment, and department authority", () => {
    const service = new ImprovementService(createMemoryImprovementStore());
    for (const permission of [
      "department:create",
      "department:activate",
      "approval:decide",
      "approval:decide:permanent",
      "model:candidate:promote",
      "training:approve",
      "training:execute",
      "evaluation:gate:decide",
      "model:rollback:execute",
    ] as const) {
      expect(ROLE_PERMISSIONS.department_agent.has(permission)).toBe(false);
      expect(() => service.assertCannotPerform(product, permission)).toThrow(new RegExp(permission.replace(":", "\\:")));
    }
    expect(ROLE_PERMISSIONS.ceo_agent.has("approval:decide:permanent")).toBe(false);
    expect(buildProposal({
      problem: "Track the saturated GPU.",
      signals: [resource],
      activeSlugs: ACTIVE,
      expectedBenefit: "Monitoring owns the baseline.",
      estimatedCost: "No new model.",
      risk: "The baseline could be noisy.",
      successCriteria: "GPU saturation above 90% is reported within 1 hour.",
    }).participants).toHaveLength(1);
  });
});

function evidence(passed: boolean, regression: boolean) {
  return {
    evaluatorDepartmentSlug: "evaluation" as const,
    evaluatorAgentId: evaluation.agentId ?? "",
    independent: true as const,
    passed,
    baseline: "Science failure rate 20%",
    result: passed ? "Science failure rate 4%" : "Science failure rate 25%",
    regression,
    resourceCost: "1 evaluation request",
  };
}

async function evaluatedCopy(service: ImprovementService, measured: ReturnType<typeof evidence>) {
  const proposal = await service.propose(product, {
    problem: "Science tasks fail before producing a result.",
    signals: [failure],
    activeSlugs: ACTIVE,
    expectedBenefit: "Failed science tasks return a checked result.",
    estimatedCost: "One evaluation run.",
    risk: "A false regression.",
    successCriteria: "Science task failure rate stays below 5% for 7 days.",
  });
  await service.submitForReview(product, proposal.id);
  await service.decide(ceo, proposal.id, "approved");
  await service.dispatch(orchestration, proposal.id);
  await service.requestEvaluation(product, proposal.id);
  return service.recordEvaluation(evaluation, proposal.id, measured);
}

function routingSnapshot(departmentId: string, status: string): RoutingSnapshot {
  return {
    departmentId,
    departmentStatus: status,
    agentDepartmentId: null,
    assignments: [],
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
    now: "2026-11-04T00:00:00.000Z",
    budgetAllowed: true,
    resourceAllowed: true,
    memoryKnown: false,
    servingBackend: "ollama",
    certifiedCapabilityCount: 0,
    syntheticCapabilityCount: 0,
    executionDigest: null,
  };
}
