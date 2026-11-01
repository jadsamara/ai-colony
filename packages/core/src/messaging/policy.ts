export interface MessagingPolicy {
  maxHandlerAttempts: number;
  maxPublishAttempts: number;
  retryBaseMs: number;
  retryMaxDelayMs: number;
  leaseMs: number;
  prefetch: number;
  pollMs: number;
  batchSize: number;
}

export const DEFAULT_MESSAGING_POLICY: MessagingPolicy = {
  maxHandlerAttempts: 5,
  maxPublishAttempts: 8,
  retryBaseMs: 1000,
  retryMaxDelayMs: 60_000,
  leaseMs: 30_000,
  prefetch: 10,
  pollMs: 500,
  batchSize: 20,
};

export function retryDelayMs(
  attempt: number,
  baseMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(maxDelayMs, baseMs * 2 ** exponent);
  const jitter = Math.floor(capped * 0.2 * random());
  return capped + jitter;
}

export function routingKeyFor(message: {
  addressingMode: "agent" | "department";
  recipientAgentId: string | null;
  recipientDepartmentId: string | null;
}): string {
  if (message.addressingMode === "agent") {
    if (!message.recipientAgentId) {
      throw new Error("Agent-addressed message is missing recipientAgentId");
    }
    return `agent.${message.recipientAgentId}`;
  }
  if (!message.recipientDepartmentId) {
    throw new Error("Department-addressed message is missing recipientDepartmentId");
  }
  return `department.${message.recipientDepartmentId}`;
}

export function departmentQueueName(departmentId: string): string {
  return `iacp.inbox.department.${departmentId}`;
}

export const MESSAGES_EXCHANGE = "iacp.messages";
export const DEAD_EXCHANGE = "iacp.dead";
export const DEAD_QUEUE = "iacp.dead.letters";
