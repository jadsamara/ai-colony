import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { departmentQueueName } from "@ai-colony/core";
import { RabbitMessageTransport } from "@ai-colony/messaging";
import { resolveIntegrationRabbitUrl } from "../helpers/isolation.js";

function integrationRabbitUrl(): string | null {
  if (!process.env.INTEGRATION_RABBITMQ_URL) {
    return null;
  }
  return resolveIntegrationRabbitUrl(process.env);
}

async function brokerAvailable(rabbitUrl: string): Promise<RabbitMessageTransport | null> {
  const transport = new RabbitMessageTransport(rabbitUrl, 10);
  try {
    await transport.connect();
    return transport;
  } catch {
    await transport.close().catch(() => undefined);
    return null;
  }
}

describe("RabbitMQ transport", () => {
  let transport: RabbitMessageTransport | null = null;

  afterAll(async () => {
    await transport?.close();
  });

  it("routes an agent message to that agent's department queue and survives a reconnect", async (context) => {
    const rabbitUrl = integrationRabbitUrl();
    if (!rabbitUrl) {
      context.skip();
      return;
    }
    transport = await brokerAvailable(rabbitUrl);
    if (!transport) {
      context.skip();
      return;
    }
    const departmentA = randomUUID();
    const departmentB = randomUUID();
    const agentA = randomUUID();
    const received: string[] = [];
    await transport.provisionDepartment(departmentA);
    await transport.provisionDepartment(departmentB);
    await transport.bindAgent(departmentA, agentA);
    await transport.consume(departmentQueueName(departmentA), async (delivery) => {
      received.push(delivery.routingKey);
      await delivery.ack();
    });
    await transport.consume(departmentQueueName(departmentB), async (delivery) => {
      received.push(`wrong:${delivery.routingKey}`);
      await delivery.ack();
    });
    const body = Buffer.from(JSON.stringify({ probe: true }));
    await transport.publish({
      messageId: randomUUID(),
      routingKey: `agent.${agentA}`,
      inboxDepartmentId: departmentA,
      recipientAgentId: agentA,
      body,
      correlationId: randomUUID(),
      attempt: 1,
    });
    await waitFor(() => received.length === 1);
    expect(received).toEqual([`agent.${agentA}`]);
    const other = await transport.checkQueue(departmentQueueName(departmentB));
    expect(other.messageCount).toBe(0);

    await transport.dropConnection();
    await waitFor(() => transport?.healthy() === true);
    await transport.publish({
      messageId: randomUUID(),
      routingKey: `department.${departmentA}`,
      inboxDepartmentId: departmentA,
      recipientAgentId: null,
      body,
      correlationId: randomUUID(),
      attempt: 1,
    });
    await waitFor(() => received.length === 2);
    expect(received[1]).toBe(`department.${departmentA}`);
    await transport.retireDepartment(departmentA);
    await transport.retireDepartment(departmentB);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 10_000) {
      throw new Error("Timed out waiting for RabbitMQ");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
