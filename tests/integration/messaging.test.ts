import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { schema, createPersistence } from "@ai-colony/database";
import {
  Authorizer,
  DEFAULT_MESSAGING_POLICY,
  MessageHandlingError,
  MessagingService,
} from "@ai-colony/core";
import { publishOutboxBatch, ScriptedTransport } from "@ai-colony/messaging";
import {
  ADMIN_ID,
  auth,
  budget,
  createTestApp,
  departmentBody,
  parameterBudget,
  provisionDepartment,
} from "../helpers/app.js";
import { testDb } from "../helpers/db.js";

describe("IACP messaging", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("sends authorized messages, isolates inboxes, and records an outbox row", async () => {
    app = await createTestApp();
    const alpha = await createReadyAgent(app, "alpha");
    const beta = await createReadyAgent(app, "beta");
    const gamma = await createReadyAgent(app, "gamma");
    const correlationId = randomUUID();
    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: directMessage(beta.agentId, correlationId),
    });
    expect(sent.statusCode).toBe(201);
    const message = sent.json().message;
    expect(message.senderAgentId).toBe(alpha.agentId);
    expect(message.senderDepartmentId).toBe(alpha.departmentId);
    expect(message.recipientAgentId).toBe(beta.agentId);
    expect(message.recipientDepartmentId).toBeNull();
    expect(message.inboxDepartmentId).toBe(beta.departmentId);
    expect(message.protocolVersion).toBe("1.0");
    expect(message.status).toBe("accepted");

    const spoofed = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: { ...directMessage(beta.agentId), senderAgentId: gamma.agentId },
    });
    expect(spoofed.statusCode).toBe(400);

    const asAdmin = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(ADMIN_ID),
      payload: directMessage(beta.agentId),
    });
    expect(asAdmin.statusCode).toBe(403);
    expect(asAdmin.json().error.code).toBe("SENDER_NOT_AGENT");

    const reader = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${message.messageId}`,
      headers: auth(beta.principalId),
    });
    expect(reader.statusCode).toBe(200);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${message.messageId}`,
      headers: auth(gamma.principalId),
    });
    expect(hidden.statusCode).toBe(404);

    const departmentMessage = await app.inject({
      method: "POST",
      url: "/api/v1/messages/collaboration",
      headers: auth(alpha.principalId),
      payload: {
        messageType: "COLLABORATION_REQUEST",
        recipientDepartmentId: beta.departmentId,
        priority: 5,
        payload: {
          subject: "Joint note",
          objective: "Share a recorded observation",
          requestedContribution: "Read it",
          deadline: null,
        },
      },
    });
    expect(departmentMessage.statusCode).toBe(201);
    const visibleToDepartment = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${departmentMessage.json().message.messageId}`,
      headers: auth(beta.principalId),
    });
    expect(visibleToDepartment.statusCode).toBe(200);
    expect(hidden.statusCode).toBe(404);

    const outbox = await testDb()
      .select()
      .from(schema.messageOutbox)
      .where(eq(schema.messageOutbox.messageId, message.messageId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.status).toBe("pending");

    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/audit-events?eventType=message.accepted&limit=20",
      headers: auth(ADMIN_ID),
    });
    expect(audit.statusCode).toBe(200);
    expect(
      audit.json().data.some((event: { targetId: string }) => event.targetId === message.messageId),
    ).toBe(true);
  });

  it("replays an idempotency key and rejects a conflicting reuse", async () => {
    app = await createTestApp();
    const alpha = await createReadyAgent(app, "idem");
    const beta = await createReadyAgent(app, "idem-dst");
    const payload = { ...directMessage(beta.agentId), idempotencyKey: "task-key-001" };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().message.messageId).toBe(first.json().message.messageId);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: {
        ...payload,
        payload: { ...payload.payload, objective: "A different objective" },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("keeps the message and outbox insert atomic", async () => {
    app = await createTestApp();
    const alpha = await createReadyAgent(app, "atomic");
    const beta = await createReadyAgent(app, "atomic-dst");
    const persistence = createPersistence(testDb(), async () => undefined);
    const before = await countMessages();
    await expect(
      persistence.transaction(async (repos) => {
        await repos.messages.insertAccepted({
          id: randomUUID(),
          messageType: "HEALTH_ALERT",
          senderAgentId: alpha.agentId,
          senderDepartmentId: alpha.departmentId,
          recipientAgentId: beta.agentId,
          recipientDepartmentId: null,
          addressingMode: "agent",
          inboxDepartmentId: beta.departmentId,
          correlationId: randomUUID(),
          causationId: null,
          replyToMessageId: null,
          priority: 5,
          payload: {
            severity: "info",
            component: "test",
            summary: "rollback",
            observedAt: "2026-10-31T12:00:00.000Z",
          },
          payloadHash: "a".repeat(64),
          idempotencyKey: null,
          metadata: {},
          expiresAt: null,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await countMessages()).toBe(before);
  });

  it("confirms a publish, recovers an abandoned lease, and records delivery once", async () => {
    app = await createTestApp();
    const alpha = await createReadyAgent(app, "pub");
    const beta = await createReadyAgent(app, "pub-dst");
    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: directMessage(beta.agentId),
    });
    const message = sent.json().message;
    const persistence = createPersistence(testDb(), async () => undefined);
    const transport = new ScriptedTransport();
    await transport.connect();
    transport.failNext = true;
    const policy = { ...DEFAULT_MESSAGING_POLICY, maxPublishAttempts: 3, retryBaseMs: 50_000 };
    await publishOutboxBatch({ persistence, transport, workerId: "publisher-a", policy });
    expect(transport.published).toHaveLength(0);
    const delayed = await testDb()
      .select()
      .from(schema.messageOutbox)
      .where(eq(schema.messageOutbox.messageId, message.messageId));
    expect(delayed[0]?.status).toBe("pending");
    expect(delayed[0] && delayed[0].availableAt.getTime()).toBeGreaterThan(Date.now());

    await testDb()
      .update(schema.messageOutbox)
      .set({
        availableAt: new Date(Date.now() - 1000),
        leaseUntil: new Date("2000-01-01T00:00:00Z"),
        status: "publishing",
      })
      .where(eq(schema.messageOutbox.messageId, message.messageId));
    await publishOutboxBatch({ persistence, transport, workerId: "publisher-b", policy });
    expect(transport.published).toHaveLength(1);
    expect(transport.published[0]?.routingKey).toBe(`agent.${beta.agentId}`);
    const published = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${message.messageId}`,
      headers: auth(alpha.principalId),
    });
    expect(published.json().message.status).toBe("published");

    let calls = 0;
    const service = new MessagingService(
      persistence,
      new Authorizer(),
      { ...DEFAULT_MESSAGING_POLICY, maxHandlerAttempts: 3 },
      async () => {
        calls += 1;
      },
    );
    const first = await service.processInbound({
      workerId: "consumer-a",
      routingKey: `agent.${beta.agentId}`,
      body: message,
    });
    const second = await service.processInbound({
      workerId: "consumer-b",
      routingKey: `agent.${beta.agentId}`,
      body: message,
    });
    expect(first).toMatchObject({ action: "ack", disposition: "recorded" });
    expect(second).toMatchObject({ action: "ack", disposition: "duplicate" });
    expect(calls).toBe(1);

    const [recorded, duplicate] = await Promise.all([
      service.processInbound({
        workerId: "consumer-c",
        routingKey: `agent.${beta.agentId}`,
        body: { ...message, status: "published" },
      }),
      service.processInbound({
        workerId: "consumer-d",
        routingKey: `agent.${beta.agentId}`,
        body: { ...message, status: "published" },
      }),
    ]);
    expect(recorded.action).toBe("ack");
    expect(duplicate.action).toBe("ack");
    if (recorded.action === "ack" && duplicate.action === "ack") {
      expect([recorded.disposition, duplicate.disposition].sort()).toEqual([
        "duplicate",
        "duplicate",
      ]);
    }
    expect(calls).toBe(1);

    const acknowledged = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${message.messageId}/acknowledge`,
      headers: auth(beta.principalId),
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().message.status).toBe("acknowledged");
    const stranger = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${message.messageId}/acknowledge`,
      headers: auth(alpha.principalId),
    });
    expect(stranger.statusCode).toBe(403);
  });

  it("retries with backoff, dead-letters exhaustion, and redrives", async () => {
    app = await createTestApp();
    const alpha = await createReadyAgent(app, "retry");
    const beta = await createReadyAgent(app, "retry-dst");
    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: directMessage(beta.agentId),
    });
    const message = sent.json().message;
    const persistence = createPersistence(testDb(), async () => undefined);
    const service = new MessagingService(
      persistence,
      new Authorizer(),
      {
        ...DEFAULT_MESSAGING_POLICY,
        maxHandlerAttempts: 2,
        retryBaseMs: 5_000,
        retryMaxDelayMs: 5_000,
      },
      async () => {
        throw new MessageHandlingError("transient dependency", false);
      },
      () => 0,
    );
    const retry = await service.processInbound({
      workerId: "consumer",
      routingKey: `agent.${beta.agentId}`,
      body: message,
    });
    expect(retry).toMatchObject({ action: "ack", disposition: "retry_scheduled" });
    const scheduled = await testDb()
      .select()
      .from(schema.messageOutbox)
      .where(eq(schema.messageOutbox.messageId, message.messageId));
    const next = scheduled.find((row) => row.attempt === 2);
    expect(next?.availableAt.getTime()).toBeGreaterThan(Date.now() + 4_000);

    const dead = await service.processInbound({
      workerId: "consumer",
      routingKey: `agent.${beta.agentId}`,
      body: message,
    });
    expect(dead).toMatchObject({ action: "ack", disposition: "dead_lettered" });
    const letters = await app.inject({
      method: "GET",
      url: "/api/v1/dead-letters?status=open",
      headers: auth(ADMIN_ID),
    });
    expect(letters.statusCode).toBe(200);
    const letter = letters
      .json()
      .data.find((row: { messageId: string }) => row.messageId === message.messageId);
    expect(letter.reason).toBe("retries_exhausted");
    const hidden = await app.inject({
      method: "GET",
      url: "/api/v1/dead-letters",
      headers: auth(alpha.principalId),
    });
    expect(hidden.statusCode).toBe(403);

    const redriven = await app.inject({
      method: "POST",
      url: `/api/v1/dead-letters/${letter.deadLetterId}/redrive`,
      headers: auth(ADMIN_ID),
    });
    expect(redriven.statusCode).toBe(200);
    expect(redriven.json().message.status).toBe("accepted");
    expect(redriven.json().deadLetter.status).toBe("redriven");
  });

  it("does not execute an expired message or privileged side effects", async () => {
    app = await createTestApp();
    const alpha = await createReadyAgent(app, "guard");
    const beta = await createReadyAgent(app, "guard-dst");
    const model = await app.inject({
      method: "POST",
      url: "/api/v1/models",
      headers: auth(ADMIN_ID),
      payload: {
        displayName: "Fixture",
        modelFamily: "fixture",
        provider: "local",
        parameterCount: 1,
        modelType: "causal-lm",
        artifactUri: null,
        deploymentTarget: "none",
        status: "not_deployed",
        quantization: null,
        contextWindow: null,
        capabilities: [],
        trainable: false,
      },
    });
    const modelId = model.json().model.id as string;
    const beforeDepartments = await countDepartments();
    const beforeBudget = await app.inject({
      method: "GET",
      url: `/api/v1/departments/${beta.departmentId}`,
      headers: auth(ADMIN_ID),
    });

    const training = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: {
        messageType: "TRAINING_REQUEST",
        recipientAgentId: beta.agentId,
        payload: {
          targetModelId: modelId,
          learningObjective: "Record the request only",
          datasetReference: "dataset://none",
          trainingConstraints: { maxParameterCount: 1, notes: "Do not train" },
          evaluationRequirements: ["none"],
        },
      },
    });
    expect(training.statusCode).toBe(201);
    const proposal = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: {
        messageType: "EVOLUTION_PROPOSAL",
        recipientDepartmentId: beta.departmentId,
        payload: {
          proposalType: "new_department",
          objective: "Propose Engineering without creating it",
          affectedDepartments: [alpha.departmentId],
          expectedBenefit: "Later implementation",
          requiredResources: "Approval",
          evaluationCriteria: ["Still proposed"],
        },
      },
    });
    expect(proposal.statusCode).toBe(201);
    const resources = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: {
        messageType: "RESOURCE_REQUEST",
        recipientAgentId: beta.agentId,
        payload: {
          resource: "cpu",
          amount: 999,
          unit: "millicores",
          justification: "This must not change the budget",
          neededBy: null,
        },
      },
    });
    expect(resources.statusCode).toBe(201);
    const afterModel = await app.inject({
      method: "GET",
      url: `/api/v1/models/${modelId}`,
      headers: auth(ADMIN_ID),
    });
    expect(afterModel.json().model.status).toBe("not_deployed");
    expect(await countDepartments()).toBe(beforeDepartments);
    const afterBudget = await app.inject({
      method: "GET",
      url: `/api/v1/departments/${beta.departmentId}`,
      headers: auth(ADMIN_ID),
    });
    expect(afterBudget.json().department.resourceBudget).toEqual(
      beforeBudget.json().department.resourceBudget,
    );

    const expiring = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: {
        ...directMessage(beta.agentId),
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    const expiredMessage = expiring.json().message;
    await testDb()
      .update(schema.iacpMessages)
      .set({ expiresAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(schema.iacpMessages.id, expiredMessage.messageId));
    let handled = false;
    const service = new MessagingService(
      createPersistence(testDb(), async () => undefined),
      new Authorizer(),
      DEFAULT_MESSAGING_POLICY,
      async () => {
        handled = true;
      },
    );
    const outcome = await service.processInbound({
      workerId: "consumer",
      routingKey: `agent.${beta.agentId}`,
      body: { ...expiredMessage, expiresAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(outcome).toMatchObject({ action: "ack", disposition: "expired" });
    expect(handled).toBe(false);

    const inactive = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: departmentBody("not-yet"),
    });
    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(alpha.principalId),
      payload: {
        ...directMessage(beta.agentId),
        recipientAgentId: undefined,
        recipientDepartmentId: inactive.json().department.id,
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("RECIPIENT_NOT_ELIGIBLE");
  });

  it("claims disjoint outbox batches and preserves correlation across a reply", async () => {
    app = await createTestApp();
    const alpha = await createReadyAgent(app, "batch");
    const beta = await createReadyAgent(app, "batch-dst");
    const correlationId = randomUUID();
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const sent = await app.inject({
        method: "POST",
        url: "/api/v1/messages",
        headers: auth(alpha.principalId),
        payload: { ...directMessage(beta.agentId, correlationId), priority: index },
      });
      ids.push(sent.json().message.messageId as string);
    }
    const persistence = createPersistence(testDb(), async () => undefined);
    const [first, second] = await Promise.all([
      persistence.transaction((repos) => repos.messages.claimOutbox("worker-a", 2, 30_000)),
      persistence.transaction((repos) => repos.messages.claimOutbox("worker-b", 2, 30_000)),
    ]);
    const claimed = [...first, ...second].map((row) => row.message.messageId);
    expect(new Set(claimed).size).toBe(4);
    expect(claimed.sort()).toEqual([...ids].sort());

    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: auth(beta.principalId),
      payload: {
        ...directMessage(alpha.agentId),
        messageType: "TASK_RESULT",
        replyToMessageId: ids[0],
        payload: {
          taskId: directMessage(beta.agentId).payload.taskId,
          status: "recorded",
          summary: "Receipt only",
          artifactReferences: [],
        },
      },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().message.correlationId).toBe(correlationId);
    expect(reply.json().message.replyToMessageId).toBe(ids[0]);
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${correlationId}`,
      headers: auth(alpha.principalId),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().data.length).toBeGreaterThanOrEqual(2);
  });
});

async function createReadyAgent(app: FastifyInstance, suffix: string) {
  const department = await provisionDepartment(app, departmentBody(suffix));
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    headers: auth(ADMIN_ID),
    payload: {
      departmentId: department.id,
      name: `Agent ${suffix}`,
      role: "department_agent",
      description: `${suffix} description`,
      capabilities: ["messaging"],
      computeBudget: budget({ cpu: 100, memory: 256, executions: 1 }),
      parameterBudget: parameterBudget(0),
    },
  });
  expect(created.statusCode).toBe(201);
  const agent = created.json().agent as {
    id: string;
    principalId: string;
    departmentId: string;
  };
  const initialized = await app.inject({
    method: "POST",
    url: `/api/v1/agents/${agent.id}/initialize`,
    headers: auth(ADMIN_ID),
  });
  expect(initialized.statusCode).toBe(200);
  return { agentId: agent.id, principalId: agent.principalId, departmentId: agent.departmentId };
}

function directMessage(recipientAgentId: string, correlationId?: string) {
  return {
    messageType: "TASK_REQUEST" as const,
    recipientAgentId,
    ...(correlationId ? { correlationId } : {}),
    priority: 5,
    payload: {
      taskId: "00000000-0000-4000-8000-0000000000aa",
      objective: "Record this request",
      constraints: ["Do not infer"],
      expectedOutput: "A stored receipt",
      deadline: null,
      contextReferences: [],
    },
  };
}

async function countMessages(): Promise<number> {
  const [row] = await testDb().execute<{ count: number }>(
    sql`select count(*)::int as count from messages`,
  );
  return Number(row?.count ?? 0);
}

async function countDepartments(): Promise<number> {
  const [row] = await testDb().execute<{ count: number }>(
    sql`select count(*)::int as count from departments`,
  );
  return Number(row?.count ?? 0);
}
