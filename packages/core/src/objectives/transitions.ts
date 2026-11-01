import type { ObjectiveStatus, TaskStatus } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";

const OBJECTIVE_TRANSITIONS: Record<ObjectiveStatus, readonly ObjectiveStatus[]> = {
  submitted: ["planning", "cancelled"],
  planning: ["awaiting_approval", "scheduled", "failed", "cancelled"],
  awaiting_approval: ["scheduled", "cancelled", "failed"],
  scheduled: ["running", "cancelled", "failed"],
  running: ["synthesizing", "failed", "cancelled"],
  synthesizing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["ready", "cancelled", "failed"],
  ready: ["dispatched", "cancelled", "failed"],
  dispatched: ["running", "timed_out", "cancelled", "failed"],
  running: ["completed", "failed", "timed_out", "cancelled"],
  timed_out: ["ready", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertObjectiveTransition(from: ObjectiveStatus, to: ObjectiveStatus): void {
  if (!OBJECTIVE_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Objective cannot move from ${from} to ${to}`,
      409,
    );
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_TRANSITION", `Task cannot move from ${from} to ${to}`, 409);
  }
}

export function isTerminalObjective(status: ObjectiveStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isTerminalTask(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
