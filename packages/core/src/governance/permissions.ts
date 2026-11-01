import type { RoleName } from "@ai-colony/contracts";
import { ROLE_NAMES } from "@ai-colony/contracts";

export const PERMISSIONS = [
  "agent:create",
  "agent:update",
  "agent:start",
  "agent:stop",
  "agent:archive",
  "agent:assign-role",
  "department:create",
  "department:update",
  "department:activate",
  "department:archive",
  "model:register",
  "budget:request",
  "budget:approve",
  "audit:read",
  "approval:request",
  "approval:decide",
  "approval:decide:permanent",
  "message:publish",
  "message:read",
  "message:consume",
  "message:acknowledge",
  "message:dead_letter:read",
  "message:dead_letter:redrive",
  "message:admin",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  "agent:create": "Register an agent in an active department",
  "agent:update": "Update mutable agent profile fields or attach a lifecycle executor",
  "agent:start": "Initialize, resume, or start an agent lifecycle",
  "agent:stop": "Pause, yield, stop, or report failure for an agent",
  "agent:archive": "Archive an agent",
  "agent:assign-role": "Assign an agent role. Does not include self-assignment",
  "department:create": "Propose a department",
  "department:update": "Update department profile fields, pause, deprecate, or fail a department",
  "department:activate": "Resume a paused department",
  "department:archive": "Archive a department",
  "model:register": "Register model metadata or a new immutable model version",
  "budget:request": "Request a budget change",
  "budget:approve": "Approve a budget change for a target the actor does not belong to",
  "audit:read": "Read append-only audit events",
  "approval:request": "Open an approval request",
  "approval:decide": "Decide temporary department approvals",
  "approval:decide:permanent": "Decide permanent department creation and activation",
  "message:publish": "Send an IACP message as the authenticated agent",
  "message:read": "Read messages the actor sent or is allowed to receive",
  "message:consume": "Pull the authenticated agent's inbox",
  "message:acknowledge": "Acknowledge or reject a delivered message addressed to the actor",
  "message:dead_letter:read": "Inspect dead letters the actor is allowed to see",
  "message:dead_letter:redrive": "Republish a dead-lettered message through the outbox",
  "message:admin": "Read messaging records and metrics across the colony",
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  system_administrator:
    "Bootstrap operator outside the colony. Not an agent role. Required for permanent organizational approval.",
  ceo_agent:
    "Organizational principal. Can request and decide temporary department changes. Cannot act as system administrator.",
  orchestration_agent:
    "Coordinates agents and may propose departments. Cannot approve organizational changes.",
  evolution_agent: "May propose departments and agents. Cannot approve its own proposals.",
  monitoring_agent:
    "Reads audit events and may publish health messages. Cannot approve organizational changes.",
  department_agent:
    "Ordinary department member. Can send and read its own messages. Cannot change departments, budgets, or roles.",
  read_only_observer: "Reads colony state and audit events.",
};

const ALL_PERMISSIONS = new Set<Permission>(PERMISSIONS);

function grants(...permissions: Permission[]): ReadonlySet<Permission> {
  return new Set(permissions);
}

export const ROLE_PERMISSIONS: Record<RoleName, ReadonlySet<Permission>> = {
  system_administrator: ALL_PERMISSIONS,
  ceo_agent: grants(
    "agent:create",
    "agent:update",
    "agent:start",
    "agent:stop",
    "agent:archive",
    "department:create",
    "department:update",
    "department:activate",
    "department:archive",
    "budget:request",
    "budget:approve",
    "audit:read",
    "approval:request",
    "approval:decide",
    "message:publish",
    "message:read",
    "message:consume",
    "message:acknowledge",
    "message:dead_letter:read",
  ),
  orchestration_agent: grants(
    "agent:create",
    "agent:update",
    "agent:start",
    "agent:stop",
    "department:create",
    "department:update",
    "budget:request",
    "approval:request",
    "audit:read",
    "message:publish",
    "message:read",
    "message:consume",
    "message:acknowledge",
  ),
  evolution_agent: grants(
    "agent:create",
    "department:create",
    "department:update",
    "budget:request",
    "approval:request",
    "message:publish",
    "message:read",
    "message:consume",
    "message:acknowledge",
  ),
  monitoring_agent: grants(
    "audit:read",
    "message:publish",
    "message:read",
    "message:consume",
    "message:acknowledge",
    "message:dead_letter:read",
  ),
  department_agent: grants(
    "message:publish",
    "message:read",
    "message:consume",
    "message:acknowledge",
  ),
  read_only_observer: grants("audit:read"),
};

export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value);
}

export function permissionsForRole(role: RoleName): Permission[] {
  return [...ROLE_PERMISSIONS[role]].sort();
}

export function listRoleGrants(): Array<{ role: RoleName; permission: Permission }> {
  const rows: Array<{ role: RoleName; permission: Permission }> = [];
  for (const role of ROLE_NAMES) {
    for (const permission of permissionsForRole(role)) {
      rows.push({ role, permission });
    }
  }
  return rows;
}
