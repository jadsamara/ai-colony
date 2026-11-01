import type { Message } from "@ai-colony/contracts";

export type MessageHandler = (message: Message) => Promise<void>;

export class MessageHandlingError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "MessageHandlingError";
    this.permanent = permanent;
  }
}

/**
 * Milestone 2 handler. It records that a valid envelope was received.
 * It does not infer, train, approve departments, or change budgets.
 */
export async function recordReceipt(_message: Message): Promise<void> {
  return undefined;
}
