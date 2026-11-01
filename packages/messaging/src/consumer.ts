import {
  departmentQueueName,
  type MessagingPolicy,
  type MessagingService,
  type Persistence,
} from "@ai-colony/core";
import { logEvent } from "./log.js";
import type { InboundDelivery, MessageTransport } from "./transport.js";

export async function handleDelivery(
  service: MessagingService,
  workerId: string,
  delivery: InboundDelivery,
): Promise<void> {
  let body: unknown = null;
  try {
    body = JSON.parse(delivery.body.toString("utf8")) as unknown;
  } catch {
    body = null;
  }
  const outcome = await service.processInbound({
    workerId,
    routingKey: delivery.routingKey,
    body,
  });
  const messageId =
    body && typeof body === "object" && "messageId" in body && typeof body.messageId === "string"
      ? body.messageId
      : undefined;
  const correlationId =
    body &&
    typeof body === "object" &&
    "correlationId" in body &&
    typeof body.correlationId === "string"
      ? body.correlationId
      : undefined;
  if (outcome.action === "ack") {
    await delivery.ack();
    logEvent(outcome.disposition === "recorded" ? "info" : "warn", "delivery completed", {
      workerId,
      messageId,
      correlationId,
      routingKey: delivery.routingKey,
      disposition: outcome.disposition,
    });
    return;
  }
  logEvent("warn", "delivery deferred", {
    workerId,
    messageId,
    correlationId,
    delayMs: outcome.delayMs,
  });
  await sleep(outcome.delayMs, new AbortController().signal);
  await delivery.nack(true);
}

export async function runMessageConsumer(input: {
  persistence: Persistence;
  transport: MessageTransport;
  service: MessagingService;
  workerId: string;
  policy: MessagingPolicy;
  signal: AbortSignal;
}): Promise<void> {
  await input.transport.connect();
  let inflight = 0;
  const handler = async (delivery: InboundDelivery) => {
    inflight += 1;
    try {
      await handleDelivery(input.service, input.workerId, delivery);
    } finally {
      inflight -= 1;
    }
  };
  while (!input.signal.aborted) {
    await reconcileTopology(input.persistence, input.transport, handler);
    const metrics = await input.persistence.repos.messages.metrics();
    logEvent("info", "consumer health", {
      workerId: input.workerId,
      healthy: input.transport.healthy(),
      inflight,
      deadLettersOpen: metrics.deadLettersOpen,
      outboxPending: metrics.outbox.pending,
    });
    await sleep(Math.max(input.policy.pollMs, 5000), input.signal);
  }
  while (inflight > 0) {
    await sleep(50, new AbortController().signal);
  }
  await input.transport.close();
}

async function reconcileTopology(
  persistence: Persistence,
  transport: MessageTransport,
  handler: (delivery: InboundDelivery) => Promise<void>,
): Promise<void> {
  const routing = await persistence.repos.messages.listActiveRouting();
  for (const target of routing) {
    await transport.provisionDepartment(target.departmentId);
    await transport.consume(departmentQueueName(target.departmentId), handler);
    for (const agentId of target.agentIds) {
      await transport.bindAgent(target.departmentId, agentId);
    }
  }
  for (const departmentId of await persistence.repos.messages.listArchivedDepartments()) {
    await transport.retireDepartment(departmentId);
  }
  for (const agent of await persistence.repos.messages.listArchivedAgents()) {
    await transport.unbindAgent(agent.departmentId, agent.agentId);
  }
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
