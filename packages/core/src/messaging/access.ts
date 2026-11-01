import type { Actor, AgentStatus, Department, Message } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";
import { ROLE_PERMISSIONS } from "../governance/permissions.js";

const SENDER_STATUSES = new Set<AgentStatus>(["idle", "running", "paused"]);
const RECIPIENT_AGENT_STATUSES = new Set<AgentStatus>([
  "registered",
  "initializing",
  "idle",
  "running",
  "paused",
  "stopping",
  "stopped",
  "failed",
]);

export function assertSenderEligible(
  status: AgentStatus,
  department: Department,
  agentDepartmentId: string,
): void {
  if (!SENDER_STATUSES.has(status)) {
    throw new DomainError(
      "SENDER_NOT_ELIGIBLE",
      "The sender agent cannot publish from its current lifecycle status",
      409,
      { status },
    );
  }
  if (department.id !== agentDepartmentId || department.status !== "active") {
    throw new DomainError("DEPARTMENT_NOT_ACTIVE", "The sender department must be active", 409, {
      departmentId: department.id,
      status: department.status,
    });
  }
}

export function assertRecipientDepartmentEligible(department: Department): void {
  if (department.status !== "active") {
    throw new DomainError("RECIPIENT_NOT_ELIGIBLE", "The recipient department is not active", 409, {
      departmentId: department.id,
      status: department.status,
    });
  }
}

export function assertRecipientAgentEligible(status: AgentStatus, department: Department): void {
  if (!RECIPIENT_AGENT_STATUSES.has(status)) {
    throw new DomainError(
      "RECIPIENT_NOT_ELIGIBLE",
      "The recipient agent cannot receive messages in its current lifecycle status",
      409,
      { status },
    );
  }
  assertRecipientDepartmentEligible(department);
}

export function canReadMessage(actor: Actor, message: Message): boolean {
  if (ROLE_PERMISSIONS[actor.role].has("message:admin")) {
    return true;
  }
  const granted = ROLE_PERMISSIONS[actor.role];
  if (!granted.has("message:read") && !granted.has("message:consume")) {
    return false;
  }
  if (actor.agentId && actor.agentId === message.senderAgentId) {
    return true;
  }
  if (actor.agentId && actor.agentId === message.recipientAgentId) {
    return true;
  }
  return (
    message.addressingMode === "department" &&
    actor.departmentId !== null &&
    actor.departmentId === message.recipientDepartmentId
  );
}

export function canDecideMessage(actor: Actor, message: Message): boolean {
  if (!ROLE_PERMISSIONS[actor.role].has("message:acknowledge")) {
    return false;
  }
  if (message.addressingMode === "agent") {
    return actor.agentId !== null && actor.agentId === message.recipientAgentId;
  }
  return actor.departmentId !== null && actor.departmentId === message.recipientDepartmentId;
}

/**
 * Direct cross-department delivery is allowed. A message does not grant the
 * sender the recipient's permissions, budget, or approval authority.
 */
export function crossDepartmentDeliveryAllowed(
  senderDepartmentId: string,
  recipientDepartmentId: string,
): boolean {
  return senderDepartmentId.length > 0 && recipientDepartmentId.length > 0;
}
