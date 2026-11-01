import type { Actor, ApprovalType, DepartmentType, RoleName } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";
import { isPermanentDepartmentType } from "../departments/transitions.js";

export function assertCanCreateDepartment(actor: Actor, departmentType: DepartmentType): void {
  if (departmentType === "system" && actor.role !== "system_administrator") {
    throw new DomainError(
      "AUTHORIZATION_DENIED",
      "Only a system administrator can create a system department",
      403,
    );
  }
}

export function assertCanCreateAgentWithRole(actor: Actor, role: RoleName): void {
  if (role === "system_administrator") {
    throw new DomainError(
      "PRIVILEGE_ESCALATION",
      "The system administrator role cannot be assigned to an agent",
      403,
    );
  }
  if (
    actor.role !== "system_administrator" &&
    role !== "department_agent" &&
    role !== "read_only_observer"
  ) {
    throw new DomainError(
      "PRIVILEGE_ESCALATION",
      "This principal can only create department agents or read-only observers",
      403,
      { role },
    );
  }
}

export function assertCanAssignRole(actor: Actor, targetAgentId: string, role: RoleName): void {
  if (actor.agentId !== null && actor.agentId === targetAgentId) {
    throw new DomainError(
      "SELF_PERMISSION_CHANGE_FORBIDDEN",
      "Agents cannot change their own role or permissions",
      403,
    );
  }
  if (role === "system_administrator") {
    throw new DomainError(
      "PRIVILEGE_ESCALATION",
      "The system administrator role cannot be assigned to an agent",
      403,
    );
  }
  if (actor.role !== "system_administrator") {
    throw new DomainError(
      "PRIVILEGE_ESCALATION",
      "Only a system administrator can assign roles",
      403,
    );
  }
}

export function assertCanDecideApproval(
  actor: Actor,
  approval: { requestedBy: string; approvalType: ApprovalType },
  departmentType: DepartmentType | null,
): void {
  const decidingOwnRequest = actor.principalId === approval.requestedBy;
  const bootstrapAdministrator = actor.role === "system_administrator" && actor.agentId === null;
  if (decidingOwnRequest && !bootstrapAdministrator) {
    throw new DomainError(
      "SELF_APPROVAL_FORBIDDEN",
      "A principal cannot decide an approval request they created",
      403,
    );
  }
  if (
    approval.approvalType !== "budget_change" &&
    departmentType !== null &&
    isPermanentDepartmentType(departmentType) &&
    actor.role !== "system_administrator"
  ) {
    throw new DomainError(
      "PERMANENT_APPROVAL_FORBIDDEN",
      "Permanent department changes require a system administrator. A CEO agent is not a system administrator.",
      403,
      { departmentType },
    );
  }
}

export function assertNotSelfBudgetChange(
  actor: Actor,
  target: { targetType: "department" | "agent"; targetId: string },
): void {
  if (
    actor.agentId !== null &&
    target.targetType === "agent" &&
    target.targetId === actor.agentId
  ) {
    throw new DomainError(
      "SELF_BUDGET_CHANGE_FORBIDDEN",
      "Agents cannot change their own budgets",
      403,
    );
  }
  if (
    actor.agentId !== null &&
    actor.departmentId !== null &&
    target.targetType === "department" &&
    target.targetId === actor.departmentId
  ) {
    throw new DomainError(
      "SELF_BUDGET_CHANGE_FORBIDDEN",
      "Agents cannot change the budget of their own department",
      403,
    );
  }
}
