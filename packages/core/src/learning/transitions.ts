import { createHash } from "node:crypto";
import { DomainError } from "../errors/domain-error.js";

export const LEARNING_CYCLE_STATUSES = [
  "OBSERVED",
  "GAP_VALIDATED",
  "OBJECTIVE_CREATED",
  "METHOD_SELECTED",
  "PROPOSAL_PENDING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "EVALUATING",
  "AWAITING_PROMOTION",
  "ADOPTED",
  "REJECTED",
  "INCONCLUSIVE",
  "FAILED",
  "CANCELLED",
] as const;

export type LearningCycleStatus = (typeof LEARNING_CYCLE_STATUSES)[number];

export const LEARNING_MECHANISMS = [
  "memory_acquisition",
  "memory_consolidation",
  "workflow",
  "retrieval",
  "lora",
  "knowledge_transfer",
  "no_action",
] as const;

export type LearningMechanism = (typeof LEARNING_MECHANISMS)[number];

export const OUTCOME_KINDS = [
  "MEMORY_IMPROVEMENT",
  "RETRIEVAL_IMPROVEMENT",
  "WORKFLOW_IMPROVEMENT",
  "TOOL_IMPROVEMENT",
  "MODEL_WEIGHT_IMPROVEMENT",
  "NO_VERIFIED_IMPROVEMENT",
] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const OBSERVABLE_EVIDENCE = ["evaluation", "task_outcome", "tool_failure", "human_correction"] as const;

const TRANSITIONS: Record<LearningCycleStatus, readonly LearningCycleStatus[]> = {
  OBSERVED: ["GAP_VALIDATED", "REJECTED", "CANCELLED"],
  GAP_VALIDATED: ["OBJECTIVE_CREATED", "REJECTED", "CANCELLED"],
  OBJECTIVE_CREATED: ["METHOD_SELECTED", "CANCELLED"],
  METHOD_SELECTED: ["PROPOSAL_PENDING", "EXECUTING", "INCONCLUSIVE", "REJECTED", "CANCELLED"],
  PROPOSAL_PENDING: ["AWAITING_APPROVAL", "REJECTED", "CANCELLED"],
  AWAITING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["EXECUTING", "CANCELLED"],
  EXECUTING: ["EVALUATING", "ADOPTED", "REJECTED", "FAILED", "CANCELLED"],
  EVALUATING: ["AWAITING_PROMOTION", "REJECTED", "INCONCLUSIVE", "FAILED"],
  AWAITING_PROMOTION: ["ADOPTED", "REJECTED", "CANCELLED"],
  ADOPTED: [],
  REJECTED: [],
  INCONCLUSIVE: [],
  FAILED: [],
  CANCELLED: [],
};

export function assertLearningTransition(from: LearningCycleStatus, to: LearningCycleStatus): void {
  if (from === to) {
    return;
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_TRANSITION", `Cannot move a learning cycle from ${from} to ${to}`, 409);
  }
}

export function gapFingerprint(departmentId: string, taskCategory: string, evidenceKind: string): string {
  return createHash("sha256").update(`${departmentId}\n${taskCategory}\n${evidenceKind}`).digest("hex");
}

export function selectLearningMethod(input: { failureCount: number; evidenceKind: string; proposed: string }): LearningMechanism {
  const observable = (OBSERVABLE_EVIDENCE as readonly string[]).includes(input.evidenceKind);
  if (!observable || input.failureCount < 1) {
    return "no_action";
  }
  if (input.proposed === "lora" && input.failureCount >= 2 && input.evidenceKind === "evaluation") {
    return "lora";
  }
  if ((LEARNING_MECHANISMS as readonly string[]).includes(input.proposed) && input.proposed !== "lora" && input.proposed !== "no_action") {
    return input.proposed as LearningMechanism;
  }
  return "no_action";
}

export function weightImprovementVerified(summary: { taskBaseline: number; taskCandidate: number; formatBaseline: number; formatCandidate: number }): boolean {
  return summary.taskCandidate > summary.taskBaseline && summary.formatCandidate >= summary.formatBaseline;
}

export function outcomeForMethod(method: LearningMechanism, verified: boolean): OutcomeKind {
  if (!verified) {
    return "NO_VERIFIED_IMPROVEMENT";
  }
  if (method === "memory_acquisition" || method === "memory_consolidation" || method === "knowledge_transfer") {
    return "MEMORY_IMPROVEMENT";
  }
  if (method === "retrieval") {
    return "RETRIEVAL_IMPROVEMENT";
  }
  if (method === "workflow") {
    return "WORKFLOW_IMPROVEMENT";
  }
  if (method === "lora") {
    return "MODEL_WEIGHT_IMPROVEMENT";
  }
  return "NO_VERIFIED_IMPROVEMENT";
}
