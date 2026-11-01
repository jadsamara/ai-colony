import {
  retryDelayMs,
  routingKeyFor,
  type MessagingPolicy,
  type Persistence,
} from "@ai-colony/core";
import type { MessageTransport } from "./transport.js";
import { logEvent } from "./log.js";

export async function publishOutboxBatch(input: {
  persistence: Persistence;
  transport: MessageTransport;
  workerId: string;
  policy: MessagingPolicy;
}): Promise<number> {
  const claimed = await input.persistence.transaction((repos) =>
    repos.messages.claimOutbox(input.workerId, input.policy.batchSize, input.policy.leaseMs),
  );
  for (const item of claimed) {
    const started = Date.now();
    try {
      await input.transport.provisionDepartment(item.message.inboxDepartmentId);
      if (item.message.addressingMode === "agent" && item.message.recipientAgentId) {
        await input.transport.bindAgent(
          item.message.inboxDepartmentId,
          item.message.recipientAgentId,
        );
      }
      await input.transport.publish({
        messageId: item.message.messageId,
        routingKey: routingKeyFor(item.message),
        inboxDepartmentId: item.message.inboxDepartmentId,
        recipientAgentId: item.message.recipientAgentId,
        body: Buffer.from(JSON.stringify(item.message)),
        correlationId: item.message.correlationId,
        attempt: item.attempt,
      });
      await input.persistence.transaction((repos) =>
        repos.messages.markPublished(item.outboxId, input.workerId),
      );
      logEvent("info", "message confirmed", {
        messageId: item.message.messageId,
        correlationId: item.message.correlationId,
        messageType: item.message.messageType,
        routingKey: routingKeyFor(item.message),
        latencyMs: Date.now() - started,
      });
    } catch (error) {
      const fail = item.publishAttempts >= input.policy.maxPublishAttempts;
      const delay = retryDelayMs(
        item.publishAttempts,
        input.policy.retryBaseMs,
        input.policy.retryMaxDelayMs,
      );
      await input.persistence.transaction((repos) =>
        repos.messages.schedulePublishRetry({
          outboxId: item.outboxId,
          workerId: input.workerId,
          availableAt: new Date(Date.now() + (fail ? 0 : delay)),
          error: error instanceof Error ? error.message : "publish failed",
          fail,
        }),
      );
      logEvent(
        fail ? "error" : "warn",
        fail ? "publish failed permanently" : "publish retry scheduled",
        {
          messageId: item.message.messageId,
          correlationId: item.message.correlationId,
          attempt: item.publishAttempts,
          delayMs: fail ? 0 : delay,
        },
      );
    }
  }
  return claimed.length;
}

export async function runOutboxPublisher(input: {
  persistence: Persistence;
  transport: MessageTransport;
  workerId: string;
  policy: MessagingPolicy;
  signal: AbortSignal;
}): Promise<void> {
  await input.transport.connect();
  let metricsAt = 0;
  while (!input.signal.aborted) {
    const count = await publishOutboxBatch(input);
    if (Date.now() - metricsAt > 30_000) {
      metricsAt = Date.now();
      const metrics = await input.persistence.repos.messages.metrics();
      logEvent("info", "messaging metrics", {
        workerId: input.workerId,
        healthy: input.transport.healthy(),
        ...metrics,
      });
    }
    if (count === 0) {
      await sleep(input.policy.pollMs, input.signal);
    }
  }
  await input.transport.close();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
