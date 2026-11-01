import type { Actor, MemoryScope } from "@ai-colony/contracts";
import { ROLE_PERMISSIONS } from "../governance/permissions.js";

export interface MemoryAccessTarget {
  scope: MemoryScope;
  ownerAgentId: string | null;
  departmentId: string | null;
}

export function canReadMemory(actor: Actor, memory: MemoryAccessTarget): boolean {
  const granted = ROLE_PERMISSIONS[actor.role];
  if (granted.has("memory:admin")) {
    return true;
  }
  if (memory.scope === "agent") {
    return granted.has("memory:read:own") && actor.agentId !== null && actor.agentId === memory.ownerAgentId;
  }
  if (memory.scope === "department") {
    return granted.has("memory:read:department") && actor.departmentId !== null && actor.departmentId === memory.departmentId;
  }
  return granted.has("memory:read:colony");
}

export function nextScope(scope: MemoryScope): MemoryScope | null {
  if (scope === "agent") {
    return "department";
  }
  if (scope === "department") {
    return "colony";
  }
  return null;
}
