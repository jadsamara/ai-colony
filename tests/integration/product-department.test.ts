import { QWEN3_8B_MODEL_ID, SPECIFICATION_VERSION, SYSTEM_ADMINISTRATOR_ID, type Actor, type ObjectivePlan } from "@ai-colony/contracts";
import {
  EVALUATION_DEPARTMENT_ID,
  GAMING_AGENT_ID,
  GAMING_DEPARTMENT_ID,
  GAMING_ENDPOINT_REFERENCE,
  ImprovementService,
  PRODUCT_AGENT_ID,
  PRODUCT_DEPARTMENT_ID,
  PRODUCT_ENDPOINT_REFERENCE,
  PRODUCT_SERVING_INSTANCE_ID,
  evaluateRouting,
  planErrors,
  type RoutingSnapshot,
} from "@ai-colony/core";
import {
  createImprovementRepository,
  activationReadiness,
  installProductDepartment,
  listActiveDedicatedInstances,
  listDedicatedInstances,
  schema,
  seed,
} from "@ai-colony/database";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "../helpers/db.js";

const ENGINEERING_ID = "123e24dc-c194-43e0-91a7-c4df153e5030";

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

describe("product department persistence", () => {
  it("retires Gaming, activates Product, and keeps the historical records", async () => {
    const seeded = await seed(testDb());
    expect(seeded.departmentsInserted).toBe(13);
    const again = await installProductDepartment(testDb());
    expect(again.departmentsInserted).toBe(0);
    expect(again.agentsInserted).toBe(0);
    expect(again.activeDepartments).toBe(12);
    expect(again.productStatus).toBe("active");
    expect(again.gamingStatus).toBe("archived");
    expect(again.productEndpoint).toBe(PRODUCT_ENDPOINT_REFERENCE);
    expect(again.gamingInstanceStatus).toBe("stopped");
    expect(again.engineeringStatus).toBeNull();

    const departments = await testDb().select().from(schema.departments);
    const active = departments.filter((department) => department.status === "active");
    expect(active).toHaveLength(12);
    expect(active.map((department) => department.slug)).toContain("product");
    expect(active.map((department) => department.slug)).not.toContain("gaming");
    const gaming = departments.find((department) => department.id === GAMING_DEPARTMENT_ID);
    const product = departments.find((department) => department.id === PRODUCT_DEPARTMENT_ID);
    expect(gaming).toMatchObject({ slug: "gaming", status: "archived" });
    expect(product).toMatchObject({ slug: "product", status: "active", departmentType: "system", creationSource: "api" });

    const [gamingAgent] = await testDb().select().from(schema.agents).where(eq(schema.agents.id, GAMING_AGENT_ID));
    const [productAgent] = await testDb().select().from(schema.agents).where(eq(schema.agents.id, PRODUCT_AGENT_ID));
    expect(gamingAgent).toMatchObject({ departmentId: GAMING_DEPARTMENT_ID, status: "archived" });
    expect(productAgent).toMatchObject({ departmentId: PRODUCT_DEPARTMENT_ID, roleName: "department_agent", status: "idle" });

    const instances = await testDb().select().from(schema.departmentServingInstances);
    expect(new Set(instances.map((instance) => instance.normalizedEndpoint)).size).toBe(instances.length);
    expect(instances.find((instance) => instance.id === PRODUCT_SERVING_INSTANCE_ID)).toMatchObject({
      endpointReference: PRODUCT_ENDPOINT_REFERENCE,
      normalizedEndpoint: PRODUCT_ENDPOINT_REFERENCE,
      status: "configured",
      modelVersion: "qwen3-8b-base-v1",
    });
    expect(instances.find((instance) => instance.departmentId === GAMING_DEPARTMENT_ID)).toMatchObject({
      endpointReference: GAMING_ENDPOINT_REFERENCE,
      status: "stopped",
    });
    const registered = await listDedicatedInstances(testDb());
    const required = await listActiveDedicatedInstances(testDb());
    expect(registered.find((instance) => instance.departmentId === GAMING_DEPARTMENT_ID)?.endpointReference).toBe(GAMING_ENDPOINT_REFERENCE);
    expect(required).toHaveLength(12);
    expect(required.map((instance) => instance.departmentId)).not.toContain(GAMING_DEPARTMENT_ID);
    expect(activationReadiness(required.map((instance) => instance.instanceId), required.map((instance) => instance.instanceId)).ok).toBe(true);
    expect(activationReadiness(required.map((instance) => instance.instanceId), required.slice(1).map((instance) => instance.instanceId)).ok).toBe(false);

    const gamingAudits = await testDb()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, GAMING_DEPARTMENT_ID));
    expect(gamingAudits.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "department.created",
      "department.archived",
    ]));
    const approvals = await testDb()
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.targetId, PRODUCT_DEPARTMENT_ID));
    expect(approvals.map((approval) => approval.approvalType).sort()).toEqual([
      "department_activate",
      "department_create",
    ]);
    expect(approvals.every((approval) => approval.status === "approved" && approval.decidedBy === SYSTEM_ADMINISTRATOR_ID)).toBe(true);

    const ceo = departments.find((department) => department.slug === "ceo");
    if (!ceo) {
      throw new Error("CEO department is missing");
    }
    await testDb().insert(schema.departments).values({
      id: ENGINEERING_ID,
      name: "Engineering",
      slug: "engineering",
      description: "Proposed and inactive.",
      purpose: "Remain proposed.",
      parentDepartmentId: null,
      status: "proposed",
      departmentType: "experimental",
      creationSource: "api",
      createdBy: SYSTEM_ADMINISTRATOR_ID,
      resourceBudget: ceo.resourceBudget,
      policyRef: null,
      metadata: {},
      specificationVersion: SPECIFICATION_VERSION,
    });
    const afterEngineering = await installProductDepartment(testDb());
    expect(afterEngineering.engineeringStatus).toBe("proposed");
    expect(afterEngineering.activeDepartments).toBe(12);

    const denied = evaluateRouting(routingSnapshot(GAMING_DEPARTMENT_ID, "archived"));
    expect(denied).toMatchObject({ authorization: "denied", reasonCode: "department_inactive" });
    const errors = planErrors(
      {
        summary: "Retired department",
        tasks: [{
          localId: "old-game",
          departmentSlug: "gaming",
          taskType: "gaming",
          objective: "Play",
          expectedOutput: "Score",
          dependsOn: [],
        }],
        completionCriteria: ["No assignment"],
        estimatedResources: { inferenceRequests: 1, outputTokens: 8 },
        risks: [],
      } as unknown as ObjectivePlan,
      {
        activeDepartmentSlugs: new Set(active.map((department) => department.slug)),
        staffedDepartmentSlugs: new Set(active.map((department) => department.slug)),
        maxInferenceRequests: 4,
        maxOutputTokens: 1000,
      },
    );
    expect(errors.join(" ")).toMatch(/not an active/);
  });

  it("persists the backlog and requires independent evaluation", async () => {
    await seed(testDb());
    const service = new ImprovementService(createImprovementRepository(testDb()));
    const product = actor("department_agent", PRODUCT_AGENT_ID, PRODUCT_AGENT_ID, PRODUCT_DEPARTMENT_ID);
    const ceo = actor("ceo_agent", "00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000011");
    const orchestration = actor("orchestration_agent", "00000000-0000-4000-8000-000000000202", "00000000-0000-4000-8000-000000000202", "00000000-0000-4000-8000-000000000012");
    const evaluation = actor("department_agent", "00000000-0000-4000-8000-000000000209", "00000000-0000-4000-8000-000000000209", EVALUATION_DEPARTMENT_ID);
    const before = await testDb().select().from(schema.departments);
    const proposal = await service.propose(product, {
      problem: "Science tasks fail before producing a result.",
      signals: [{
        source: "failure",
        summary: "Specialist tasks are failing before a result is returned",
        departmentSlug: "science",
      }],
      activeSlugs: before.filter((department) => department.status === "active").map((department) => department.slug),
      expectedBenefit: "Failed science tasks return a checked result.",
      estimatedCost: "One evaluation run and no new infrastructure.",
      risk: "The check could reject a valid science answer.",
      successCriteria: "Science task failure rate stays below 5% for 7 days.",
      dependencies: ["A current failure baseline"],
    });
    await service.submitForReview(product, proposal.id);
    await expect(service.decide(product, proposal.id, "approved")).rejects.toThrow(/cannot approve/);
    await service.decide(ceo, proposal.id, "approved");
    const dispatched = await service.dispatch(orchestration, proposal.id);
    expect(dispatched.work.map((item) => item.departmentSlug)).toContain("science");
    expect(dispatched.work.map((item) => item.departmentSlug)).not.toContain("gaming");
    await service.requestEvaluation(product, proposal.id);
    await expect(service.recordEvaluation(product, proposal.id, {
      evaluatorDepartmentSlug: "evaluation",
      evaluatorAgentId: evaluation.agentId ?? "",
      independent: true,
      passed: true,
      baseline: "Science failure rate 20%",
      result: "Science failure rate 4%",
      regression: false,
      resourceCost: "1 evaluation request",
    })).rejects.toThrow(/successful/);
    const completed = await service.recordEvaluation(evaluation, proposal.id, {
      evaluatorDepartmentSlug: "evaluation",
      evaluatorAgentId: evaluation.agentId ?? "",
      independent: true,
      passed: true,
      baseline: "Science failure rate 20%",
      result: "Science failure rate 4%",
      regression: false,
      resourceCost: "1 evaluation request",
    });
    expect(completed).toMatchObject({ status: "completed", successful: true, recommendation: "retain" });
    const stored = await createImprovementRepository(testDb()).find(proposal.id);
    expect(stored?.outcome).toMatch(/baseline/);
    const events = await createImprovementRepository(testDb()).listEvents(proposal.id);
    expect(events.map((event) => event.eventType)).toEqual([
      "improvement.proposed",
      "improvement.submitted",
      "improvement.decided",
      "improvement.dispatched",
      "improvement.evaluation_requested",
      "improvement.evaluated",
    ]);
    const memory = service.memoryProposal(completed);
    expect(memory.isFact).toBe(false);
    const after = await testDb().select().from(schema.departments);
    expect(after).toHaveLength(before.length);
    await expect(
      testDb().execute(sql`update product_improvement_events set event_type = 'tamper'`),
    ).rejects.toSatisfy((error: unknown) => /immutable/.test(messageChain(error)));
  });
});

function messageChain(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error && messages.length < 6) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" ");
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
