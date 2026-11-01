import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from "amqplib";
import { DEAD_EXCHANGE, DEAD_QUEUE, departmentQueueName, MESSAGES_EXCHANGE } from "@ai-colony/core";
import type { InboundDelivery, MessageTransport, OutboundMessage } from "./transport.js";

const QUORUM = { durable: true, arguments: { "x-queue-type": "quorum" } };

/**
 * RabbitMQ 4 transport.
 *
 * Quorum queues and publisher confirms give durable at-least-once delivery.
 * They do not provide exactly-once processing. A confirmed publish can still
 * be delivered twice, and a consumer ack can be lost after Postgres commits.
 * The outbox and processing records make those duplicates safe.
 *
 * Retries are scheduled in Postgres and republished. The broker dead-letter
 * exchange catches deliveries this process rejects without requeue. Consumers
 * do not nack-requeue in a tight loop.
 */
export class RabbitMessageTransport implements MessageTransport {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private closing = false;
  private connecting: Promise<void> | null = null;
  private readonly returned = new Set<string>();
  private readonly consumers = new Map<string, (delivery: InboundDelivery) => Promise<void>>();
  private readonly started = new Set<string>();
  private readonly requeues = new Map<string, number>();

  constructor(
    private readonly url: string,
    private readonly prefetch: number,
  ) {}

  async connect(): Promise<void> {
    if (this.channel) {
      return;
    }
    if (this.connecting) {
      await this.connecting;
      return;
    }
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }

  healthy(): boolean {
    return this.channel !== null && !this.closing;
  }

  async publish(message: OutboundMessage): Promise<void> {
    const channel = await this.requireChannel();
    this.returned.delete(message.messageId);
    channel.publish(MESSAGES_EXCHANGE, message.routingKey, message.body, {
      persistent: true,
      mandatory: true,
      contentType: "application/json",
      messageId: message.messageId,
      correlationId: message.correlationId,
      timestamp: Date.now(),
      headers: { "x-iacp-attempt": message.attempt },
    });
    await channel.waitForConfirms();
    if (this.returned.has(message.messageId)) {
      this.returned.delete(message.messageId);
      throw new Error(`Unroutable message ${message.messageId}`);
    }
  }

  async provisionDepartment(departmentId: string): Promise<void> {
    const channel = await this.requireChannel();
    await this.assertTopology(channel);
    const queue = departmentQueueName(departmentId);
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": DEAD_EXCHANGE,
      },
    });
    await channel.bindQueue(queue, MESSAGES_EXCHANGE, `department.${departmentId}`);
  }

  async bindAgent(departmentId: string, agentId: string): Promise<void> {
    await this.provisionDepartment(departmentId);
    const channel = await this.requireChannel();
    await channel.bindQueue(
      departmentQueueName(departmentId),
      MESSAGES_EXCHANGE,
      `agent.${agentId}`,
    );
  }

  async unbindAgent(departmentId: string, agentId: string): Promise<void> {
    const channel = await this.requireChannel();
    await channel
      .unbindQueue(departmentQueueName(departmentId), MESSAGES_EXCHANGE, `agent.${agentId}`)
      .catch(() => undefined);
  }

  async retireDepartment(departmentId: string): Promise<void> {
    const channel = await this.requireChannel();
    const queue = departmentQueueName(departmentId);
    this.consumers.delete(queue);
    await channel.deleteQueue(queue).catch(() => undefined);
  }

  async consume(
    queue: string,
    handler: (delivery: InboundDelivery) => Promise<void>,
  ): Promise<void> {
    this.consumers.set(queue, handler);
    if (this.started.has(queue)) {
      return;
    }
    await this.requireChannel();
    if (this.started.has(queue)) {
      return;
    }
    await this.startConsumer(queue, handler);
    this.started.add(queue);
  }

  async checkQueue(queue: string): Promise<{ messageCount: number; consumerCount: number }> {
    const channel = await this.requireChannel();
    const status = await channel.checkQueue(queue);
    return { messageCount: status.messageCount, consumerCount: status.consumerCount };
  }

  async dropConnection(): Promise<void> {
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    await connection?.close().catch(() => undefined);
  }

  private async open(): Promise<void> {
    const connection = await amqp.connect(this.url);
    connection.on("error", () => undefined);
    connection.on("close", () => {
      this.channel = null;
      this.connection = null;
      this.started.clear();
      if (!this.closing) {
        void this.recover();
      }
    });
    const channel = await connection.createConfirmChannel();
    await channel.prefetch(this.prefetch);
    channel.on("error", () => undefined);
    channel.on("return", (message) => {
      const messageId = message.properties.messageId;
      if (typeof messageId === "string") {
        this.returned.add(messageId);
      }
    });
    await this.assertTopology(channel);
    this.connection = connection;
    this.channel = channel;
    this.started.clear();
    for (const [queue, handler] of this.consumers) {
      await this.startConsumer(queue, handler);
      this.started.add(queue);
    }
  }

  private async recover(): Promise<void> {
    let delay = 200;
    while (!this.closing && !this.channel) {
      try {
        await this.connect();
        return;
      } catch {
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }
  }

  private async requireChannel(): Promise<ConfirmChannel> {
    if (!this.channel) {
      await this.connect();
    }
    if (!this.channel) {
      throw new Error("RabbitMQ channel is not connected");
    }
    return this.channel;
  }

  private async assertTopology(channel: ConfirmChannel): Promise<void> {
    await channel.assertExchange(MESSAGES_EXCHANGE, "topic", { durable: true });
    await channel.assertExchange(DEAD_EXCHANGE, "topic", { durable: true });
    await channel.assertQueue(DEAD_QUEUE, QUORUM);
    await channel.bindQueue(DEAD_QUEUE, DEAD_EXCHANGE, "#");
  }

  private async startConsumer(
    queue: string,
    handler: (delivery: InboundDelivery) => Promise<void>,
  ): Promise<void> {
    const channel = await this.requireChannel();
    await channel.consume(
      queue,
      (message) => {
        if (!message) {
          return;
        }
        void this.dispatch(channel, message, handler);
      },
      { noAck: false },
    );
  }

  private async dispatch(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    handler: (delivery: InboundDelivery) => Promise<void>,
  ): Promise<void> {
    const routingKey = message.fields.routingKey;
    const delivery: InboundDelivery = {
      routingKey,
      body: message.content,
      ack: async () => {
        channel.ack(message);
      },
      nack: async (requeue: boolean) => {
        const messageId = message.properties.messageId ?? routingKey;
        const attempts = (this.requeues.get(messageId) ?? 0) + 1;
        this.requeues.set(messageId, attempts);
        if (requeue && attempts > 5) {
          channel.nack(message, false, false);
          return;
        }
        channel.nack(message, false, requeue);
      },
    };
    try {
      await handler(delivery);
    } catch {
      channel.nack(message, false, false);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
