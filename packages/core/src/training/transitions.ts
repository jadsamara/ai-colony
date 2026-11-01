import type { TrainingRunStatus } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";

const TRANSITIONS: Record<TrainingRunStatus, readonly TrainingRunStatus[]> = {
  proposed: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["queued", "cancelled"],
  queued: ["preparing", "cancelled"],
  preparing: ["training", "failed", "cancelled"],
  training: ["evaluating", "failed", "cancelled"],
  evaluating: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function assertTrainingTransition(from: TrainingRunStatus, to: TrainingRunStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_TRANSITION", `Cannot move a training run from ${from} to ${to}`, 409);
  }
}

export function assertNotSelfDecision(actor: { agentId: string | null; principalId: string }, ownerId: string): void {
  if (actor.agentId && actor.principalId === ownerId) {
    throw new DomainError("SELF_APPROVAL", "An agent cannot approve its own training budget or candidate", 403);
  }
}
