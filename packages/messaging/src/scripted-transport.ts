import { DEAD_QUEUE, departmentQueueName } from "@ai-colony/core";
import type { MessageTransport, OutboundMessage } from "./transport.js";

export interface RecordedPublish extends OutboundMessage {
  queue: string;
}

/**
 * In-process transport for publisher tests. It records confirms and can fail
 * the next publish. It does not pretend to be a broker.
 */
export class ScriptedTransport implements MessageTransport {
  readonly published: RecordedPublish[] = [];
  readonly queues = new Set<string>();
  readonly bindings = new Set<string>();
  failNext = false;
  connected = false;

  async connect(): Promise<void> {
    this.connected = true;
    this.queues.add(DEAD_QUEUE);
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  healthy(): boolean {
    return this.connected;
  }

  async publish(message: OutboundMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("transport is closed");
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error("publisher confirm failed");
    }
    const queue = departmentQueueName(message.inboxDepartmentId);
    if (!this.queues.has(queue) || !this.bindings.has(`${queue}:${message.routingKey}`)) {
      throw new Error(`Unroutable message ${message.messageId}`);
    }
    this.published.push({ ...message, queue });
  }

  async provisionDepartment(departmentId: string): Promise<void> {
    const queue = departmentQueueName(departmentId);
    this.queues.add(queue);
    this.bindings.add(`${queue}:department.${departmentId}`);
  }

  async bindAgent(departmentId: string, agentId: string): Promise<void> {
    await this.provisionDepartment(departmentId);
    this.bindings.add(`${departmentQueueName(departmentId)}:agent.${agentId}`);
  }

  async unbindAgent(departmentId: string, agentId: string): Promise<void> {
    this.bindings.delete(`${departmentQueueName(departmentId)}:agent.${agentId}`);
  }

  async retireDepartment(departmentId: string): Promise<void> {
    const queue = departmentQueueName(departmentId);
    this.queues.delete(queue);
    for (const binding of [...this.bindings]) {
      if (binding.startsWith(`${queue}:`)) {
        this.bindings.delete(binding);
      }
    }
  }

  async consume(): Promise<void> {
    return undefined;
  }

  async checkQueue(queue: string): Promise<{ messageCount: number; consumerCount: number }> {
    const messageCount = this.published.filter((message) => message.queue === queue).length;
    return { messageCount, consumerCount: 0 };
  }
}
