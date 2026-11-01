import { describe, expect, it } from "vitest";
import {
  collaborationRequestPayloadSchema,
  evaluationResultPayloadSchema,
  evolutionProposalPayloadSchema,
  healthAlertPayloadSchema,
  knowledgeSharePayloadSchema,
  messagePublishSchema,
  modelCandidatePayloadSchema,
  payloadSchemaByType,
  resourceRequestPayloadSchema,
  taskRequestPayloadSchema,
  taskResultPayloadSchema,
  trainingRequestPayloadSchema,
  MESSAGE_TYPES,
} from "@ai-colony/contracts";
import {
  crossDepartmentDeliveryAllowed,
  messageIdentityHash,
  retryDelayMs,
  routingKeyFor,
} from "@ai-colony/core";

const id = "00000000-0000-4000-8000-0000000000aa";

describe("IACP schemas and delivery policy", () => {
  it("accepts all ten message payloads and rejects an empty payload", () => {
    expect(MESSAGE_TYPES).toHaveLength(10);
    expect(taskRequestPayloadSchema.parse(taskPayload()).taskId).toBe(id);
    expect(
      taskResultPayloadSchema.parse({
        taskId: id,
        status: "recorded",
        summary: "Receipt recorded. No model executed this task.",
        artifactReferences: [],
      }).status,
    ).toBe("recorded");
    expect(
      collaborationRequestPayloadSchema.parse({
        subject: "Review",
        objective: "Compare two approaches",
        requestedContribution: "A written critique",
        deadline: null,
      }).subject,
    ).toBe("Review");
    expect(
      knowledgeSharePayloadSchema.parse({
        title: "Note",
        summary: "A recorded observation",
        sourceReferences: [],
        confidence: "low",
      }).confidence,
    ).toBe("low");
    expect(
      trainingRequestPayloadSchema.parse({
        targetModelId: id,
        learningObjective: "Improve arithmetic",
        datasetReference: "dataset://local/math",
        trainingConstraints: { maxParameterCount: 0, notes: "Do not launch training" },
        evaluationRequirements: ["held-out set"],
      }).targetModelId,
    ).toBe(id);
    expect(
      modelCandidatePayloadSchema.parse({
        modelId: id,
        candidateVersion: "v2",
        artifactUri: null,
        summary: "Metadata only",
        proposedStatus: "not_deployed",
      }).artifactUri,
    ).toBeNull();
    expect(
      evaluationResultPayloadSchema.parse({
        subjectType: "message",
        subjectId: id,
        verdict: "inconclusive",
        metrics: { score: 0 },
        notes: "",
      }).verdict,
    ).toBe("inconclusive");
    expect(
      resourceRequestPayloadSchema.parse({
        resource: "cpu",
        amount: 100,
        unit: "millicores",
        justification: "More room for a future worker",
        neededBy: null,
      }).amount,
    ).toBe(100);
    expect(
      healthAlertPayloadSchema.parse({
        severity: "warning",
        component: "outbox",
        summary: "Backlog is growing",
        observedAt: "2026-10-31T12:00:00.000Z",
      }).severity,
    ).toBe("warning");
    expect(
      evolutionProposalPayloadSchema.parse({
        proposalType: "new_department",
        objective: "Add Engineering later",
        affectedDepartments: [id],
        expectedBenefit: "A place for implementation work",
        requiredResources: "None in this milestone",
        evaluationCriteria: ["approval still required"],
      }).proposalType,
    ).toBe("new_department");
    for (const messageType of MESSAGE_TYPES) {
      expect(payloadSchemaByType[messageType].safeParse({}).success).toBe(false);
    }
  });

  it("requires exactly one recipient", () => {
    expect(
      messagePublishSchema.safeParse({
        messageType: "HEALTH_ALERT",
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      messagePublishSchema.safeParse({
        messageType: "HEALTH_ALERT",
        recipientAgentId: id,
        recipientDepartmentId: id,
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("grows retry delay with a cap and jitter", () => {
    expect(retryDelayMs(1, 1000, 60_000, () => 0)).toBe(1000);
    expect(retryDelayMs(3, 1000, 60_000, () => 0)).toBe(4000);
    expect(retryDelayMs(10, 1000, 60_000, () => 0)).toBe(60_000);
    const jittered = retryDelayMs(1, 1000, 60_000, () => 1);
    expect(jittered).toBe(1200);
  });

  it("builds stable routing keys and hashes", () => {
    expect(
      routingKeyFor({
        addressingMode: "agent",
        recipientAgentId: id,
        recipientDepartmentId: null,
      }),
    ).toBe(`agent.${id}`);
    expect(
      routingKeyFor({
        addressingMode: "department",
        recipientAgentId: null,
        recipientDepartmentId: id,
      }),
    ).toBe(`department.${id}`);
    const first = messageIdentityHash({
      messageType: "HEALTH_ALERT",
      recipientAgentId: id,
      recipientDepartmentId: null,
      payload: { b: 1, a: 2 },
    });
    const second = messageIdentityHash({
      messageType: "HEALTH_ALERT",
      recipientAgentId: id,
      recipientDepartmentId: null,
      payload: { a: 2, b: 1 },
    });
    expect(first).toBe(second);
    expect(crossDepartmentDeliveryAllowed(id, "00000000-0000-4000-8000-0000000000bb")).toBe(true);
  });
});

function taskPayload() {
  return {
    taskId: id,
    objective: "Record the request",
    constraints: ["Do not infer"],
    expectedOutput: "A stored receipt",
    deadline: null,
    contextReferences: [],
  };
}
