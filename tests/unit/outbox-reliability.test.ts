import { describe, expect, it } from "vitest";
import type { Message, MessagePublish } from "@ai-colony/contracts";
import { messageSchema } from "@ai-colony/contracts";
import {
  Authorizer,
  DEFAULT_MESSAGING_POLICY,
  MessagingService,
  messageIdentityHash,
  retryDelayMs,
  summarizeOutbox,
  type Persistence,
} from "@ai-colony/core";
import { publishOutboxBatch, type MessageTransport } from "@ai-colony/messaging";

const departmentId = "00000000-0000-4000-8000-0000000000bb";

describe("outbox delivery contract", () => {
  it("leaves pending records pending when the dispatcher is not started", async () => {
    const fixture = publisherFixture(0);
    expect(fixture.state.status).toBe("pending");
    expect(fixture.state.publications).toBe(0);
  });

  it("publishes an eligible record once the dispatcher runs", async () => {
    const fixture = publisherFixture(1);
    const count = await publishOutboxBatch({
      persistence: fixture.persistence,
      transport: transport(async () => undefined),
      workerId: "publisher-test",
      policy: { ...DEFAULT_MESSAGING_POLICY, batchSize: 20 },
    });
    expect(count).toBe(1);
    expect(fixture.state.status).toBe("published");
    expect(fixture.state.publications).toBe(1);
  });

  it("keeps the record when RabbitMQ publication fails", async () => {
    const fixture = publisherFixture(1);
    const before = Date.now();
    await publishOutboxBatch({
      persistence: fixture.persistence,
      transport: transport(async () => {
        throw new Error("connection refused");
      }),
      workerId: "publisher-test",
      policy: { ...DEFAULT_MESSAGING_POLICY, retryBaseMs: 1_000, retryMaxDelayMs: 60_000 },
    });
    expect(fixture.state.status).toBe("pending");
    expect(fixture.state.marked).toBe(false);
    expect(fixture.state.retry?.fail).toBe(false);
    expect(fixture.state.retry?.error).toBe("connection refused");
    const delay = (fixture.state.retry?.availableAt.getTime() ?? 0) - before;
    expect(delay).toBeGreaterThanOrEqual(900);
    expect(delay).toBeLessThanOrEqual(retryDelayMs(1, 1_000, 60_000, () => 1) + 50);
  });

  it("fails the record only after the configured publish attempts", async () => {
    const fixture = publisherFixture(DEFAULT_MESSAGING_POLICY.maxPublishAttempts);
    await publishOutboxBatch({
      persistence: fixture.persistence,
      transport: transport(async () => {
        throw new Error("still down");
      }),
      workerId: "publisher-test",
      policy: DEFAULT_MESSAGING_POLICY,
    });
    expect(fixture.state.status).toBe("failed");
    expect(fixture.state.retry?.fail).toBe(true);
  });

  it("acks a duplicate delivery without running the handler again", async () => {
    const message = alertMessage("dead_lettered");
    let handled = false;
    const attempts: string[] = [];
    const service = new MessagingService(
      persistence({
        async lockById() {
          return { message, payloadHash: hash(message) };
        },
        async insertDeliveryAttempt(input: { outcome: string }) {
          attempts.push(input.outcome);
        },
      }),
      new Authorizer(),
      DEFAULT_MESSAGING_POLICY,
      async () => {
        handled = true;
      },
    );
    const result = await service.processInbound({
      workerId: "consumer-test",
      routingKey: `department.${departmentId}`,
      body: message,
    });
    expect(result).toEqual({ action: "ack", disposition: "duplicate" });
    expect(handled).toBe(false);
    expect(attempts).toEqual(["duplicate"]);
  });

  it("replays an identical idempotency key instead of inserting another message", async () => {
    const message = alertMessage("accepted");
    let inserted = false;
    const service = new MessagingService(
      persistence({
        async findByIdempotency() {
          return { message, payloadHash: hash(message) };
        },
        async insertAccepted() {
          inserted = true;
        },
      }),
      new Authorizer(),
      DEFAULT_MESSAGING_POLICY,
    );
    const result = await service.send(agentContext(), publishInput(message));
    expect(result.replayed).toBe(true);
    expect(result.message.messageId).toBe(message.messageId);
    expect(inserted).toBe(false);
  });

  it("groups pending records without exposing payloads", () => {
    const summary = summarizeOutbox(
      [
        {
          status: "pending",
          messageType: "TRAINING_REQUEST",
          publishAttempts: 0,
          updatedAt: "2026-11-01T16:14:32.501Z",
          lastError: null,
        },
        {
          status: "pending",
          messageType: "TASK_RESULT",
          publishAttempts: 0,
          updatedAt: "2026-11-01T16:14:31.595Z",
          lastError: null,
        },
      ],
      Date.parse("2026-11-02T20:00:00.000Z"),
    );
    expect(summary.counts).toEqual({ pending: 2 });
    expect(summary.byAttempts).toEqual([{ publishAttempts: 0, count: 2 }]);
    expect(summary.errors).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain("payload");
  });
});

function publisherFixture(publishAttempts: number) {
  const state: {
    status: string;
    marked: boolean;
    publications: number;
    retry: { fail: boolean; availableAt: Date; error: string } | null;
  } = { status: "pending", marked: false, publications: 0, retry: null };
  const persistence = {
    async transaction<T>(work: (repos: { messages: Record<string, unknown> }) => Promise<T>): Promise<T> {
      return work({
        messages: {
          async claimOutbox() {
            if (state.status !== "pending") {
              return [];
            }
            state.status = "publishing";
            return [
              {
                outboxId: "outbox-1",
                messageId: "00000000-0000-4000-8000-0000000000aa",
                attempt: 1,
                status: "publishing",
                publishAttempts,
                availableAt: new Date().toISOString(),
                publishedAt: null,
                lastError: null,
                claimedBy: "publisher-test",
                message: {
                  messageId: "00000000-0000-4000-8000-0000000000aa",
                  inboxDepartmentId: departmentId,
                  addressingMode: "department",
                  recipientAgentId: null,
                  recipientDepartmentId: departmentId,
                  correlationId: "00000000-0000-4000-8000-0000000000dd",
                  messageType: "HEALTH_ALERT",
                },
              },
            ];
          },
          async markPublished() {
            state.status = "published";
            state.marked = true;
            state.publications += 1;
          },
          async schedulePublishRetry(input: { fail: boolean; availableAt: Date; error: string }) {
            state.status = input.fail ? "failed" : "pending";
            state.retry = input;
          },
        },
      });
    },
    async ping() {
      return undefined;
    },
    async close() {
      return undefined;
    },
    repos: {},
  };
  return { state, persistence: persistence as unknown as Persistence };
}

function transport(publish: () => Promise<void>): MessageTransport {
  return {
    async connect() {
      return undefined;
    },
    async close() {
      return undefined;
    },
    healthy: () => true,
    publish,
    async provisionDepartment() {
      return undefined;
    },
    async bindAgent() {
      return undefined;
    },
    async unbindAgent() {
      return undefined;
    },
    async retireDepartment() {
      return undefined;
    },
    async consume() {
      return undefined;
    },
    async checkQueue() {
      return { messageCount: 0, consumerCount: 0 };
    },
  };
}

function persistence(messages: Record<string, unknown>): Persistence {
  const repos = { messages };
  return {
    repos: repos as unknown as Persistence["repos"],
    async transaction(work) {
      return work(repos as unknown as Persistence["repos"]);
    },
    async ping() {
      return undefined;
    },
    async close() {
      return undefined;
    },
  };
}

function alertMessage(status: "dead_lettered" | "accepted"): Message {
  return messageSchema.parse({
    messageId: "00000000-0000-4000-8000-0000000000aa",
    protocolVersion: "1.0",
    senderAgentId: "00000000-0000-4000-8000-0000000000cc",
    senderDepartmentId: departmentId,
    recipientAgentId: null,
    recipientDepartmentId: departmentId,
    addressingMode: "department",
    inboxDepartmentId: departmentId,
    correlationId: "00000000-0000-4000-8000-0000000000dd",
    causationId: null,
    replyToMessageId: null,
    priority: 5,
    createdAt: "2026-11-01T12:00:00.000Z",
    expiresAt: null,
    payloadSchemaVersion: "1.0",
    idempotencyKey: "same-key",
    metadata: {},
    status,
    updatedAt: "2026-11-01T12:00:00.000Z",
    messageType: "HEALTH_ALERT",
    payload: {
      severity: "warning",
      component: "outbox",
      summary: "Backlog is growing",
      observedAt: "2026-10-31T12:00:00.000Z",
    },
  });
}

function hash(message: Message): string {
  return messageIdentityHash({
    messageType: message.messageType,
    recipientAgentId: message.recipientAgentId,
    recipientDepartmentId: message.recipientDepartmentId,
    payload: message.payload,
  });
}

function publishInput(message: Message): MessagePublish {
  return {
    messageType: message.messageType,
    recipientDepartmentId: message.recipientDepartmentId,
    correlationId: message.correlationId,
    idempotencyKey: message.idempotencyKey,
    priority: message.priority,
    payload: message.payload,
    metadata: message.metadata,
  } as MessagePublish;
}

function agentContext() {
  return {
    correlationId: "00000000-0000-4000-8000-0000000000dd",
    actor: {
      principalId: "00000000-0000-4000-8000-0000000000cc",
      principalType: "agent" as const,
      role: "department_agent" as const,
      agentId: "00000000-0000-4000-8000-0000000000cc",
      departmentId,
      permissions: [],
    },
  };
}
