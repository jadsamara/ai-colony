export interface OutboundMessage {
  messageId: string;
  routingKey: string;
  inboxDepartmentId: string;
  recipientAgentId: string | null;
  body: Buffer;
  correlationId: string;
  attempt: number;
}

export interface InboundDelivery {
  routingKey: string;
  body: Buffer;
  ack(): Promise<void>;
  nack(requeue: boolean): Promise<void>;
}

/**
 * Transport-independent messaging port. RabbitMQ is the Milestone 2 adapter.
 * A future Google Cloud Pub/Sub adapter can implement this interface without
 * changing message acceptance, the outbox, or inbox authorization.
 */
export interface MessageTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  healthy(): boolean;
  publish(message: OutboundMessage): Promise<void>;
  provisionDepartment(departmentId: string): Promise<void>;
  bindAgent(departmentId: string, agentId: string): Promise<void>;
  unbindAgent(departmentId: string, agentId: string): Promise<void>;
  retireDepartment(departmentId: string): Promise<void>;
  consume(queue: string, handler: (delivery: InboundDelivery) => Promise<void>): Promise<void>;
  checkQueue(queue: string): Promise<{ messageCount: number; consumerCount: number }>;
}
