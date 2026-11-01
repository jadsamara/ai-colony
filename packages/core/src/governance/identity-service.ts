import type { Actor } from "@ai-colony/contracts";
import { isRoleName, permissionsForRole } from "../governance/permissions.js";
import type { Persistence } from "../ports/repositories.js";

export class IdentityService {
  constructor(private readonly persistence: Persistence) {}

  async getActor(principalId: string): Promise<Actor | null> {
    const principal = await this.persistence.repos.principals.findById(principalId);
    if (!principal || !isRoleName(principal.role)) {
      return null;
    }
    if (principal.agentId) {
      const agent = await this.persistence.repos.agents.findById(principal.agentId);
      if (!agent || agent.role !== principal.role || agent.status === "archived") {
        return null;
      }
      return {
        principalId: principal.id,
        principalType: principal.principalType,
        role: principal.role,
        agentId: agent.id,
        departmentId: agent.departmentId,
        permissions: permissionsForRole(principal.role),
      };
    }
    return {
      principalId: principal.id,
      principalType: principal.principalType,
      role: principal.role,
      agentId: null,
      departmentId: null,
      permissions: permissionsForRole(principal.role),
    };
  }
}
