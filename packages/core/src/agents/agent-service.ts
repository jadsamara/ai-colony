import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentCreate,
  AgentListQuery,
  AgentUpdate,
  RoleName,
} from "@ai-colony/contracts";
import { SPECIFICATION_VERSION } from "@ai-colony/contracts";
import {
  assertAgentBudgetWithinDepartment,
  parseParameterBudget,
  parseResourceBudget,
} from "../budgets/budget.js";
import { snapshot, type RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import {
  assertCanAssignRole,
  assertCanCreateAgentWithRole,
} from "../governance/self-protection.js";
import { assertNoHierarchyCycle } from "../departments/hierarchy.js";
import { decodeCursor } from "../pagination.js";
import type { Page, Persistence, Repositories } from "../ports/repositories.js";

export class AgentService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
  ) {}

  async create(ctx: RequestContext, input: AgentCreate): Promise<Agent> {
    this.authorizer.assert(ctx.actor, "agent:create");
    assertCanCreateAgentWithRole(ctx.actor, input.role);
    const computeBudget = parseResourceBudget(input.computeBudget);
    const parameterBudget = parseParameterBudget(input.parameterBudget);
    const id = randomUUID();
    const principalId = randomUUID();
    return this.persistence.transaction(async (repos) => {
      const department = await repos.departments.lockById(input.departmentId);
      if (!department) {
        throw new DomainError("INVALID_REFERENCE", "Department does not exist", 422);
      }
      if (department.status !== "active") {
        throw new DomainError(
          "DEPARTMENT_NOT_ACTIVE",
          "Agents can only be registered in an active department",
          409,
          { status: department.status },
        );
      }
      assertAgentBudgetWithinDepartment(computeBudget, parameterBudget, department.resourceBudget);
      if (input.modelId) {
        const model = await repos.models.findById(input.modelId);
        if (!model) {
          throw new DomainError("INVALID_REFERENCE", "Model does not exist", 422);
        }
      }
      if (input.parentAgentId) {
        await this.assertParentAgent(repos, id, input.parentAgentId);
      }
      const created = await repos.agents.insert({
        id,
        departmentId: input.departmentId,
        name: input.name,
        role: input.role,
        description: input.description,
        capabilities: input.capabilities ?? [],
        modelId: input.modelId ?? null,
        adapterVersion: input.adapterVersion ?? null,
        memoryNamespace: input.memoryNamespace ?? `agent:${id}`,
        computeBudget,
        parameterBudget,
        status: "registered",
        performanceMetrics: input.performanceMetrics ?? {},
        parentAgentId: input.parentAgentId ?? null,
        specificationVersion: SPECIFICATION_VERSION,
        principalId,
        principalType: "agent",
      });
      await repos.audit.append({
        eventType: "agent.created",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "agent",
        targetId: created.id,
        action: "create",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: snapshot(created),
        metadata: { principalId },
      });
      return created;
    });
  }

  async get(id: string): Promise<Agent> {
    const agent = await this.persistence.repos.agents.findById(id);
    if (!agent) {
      throw notFound("Agent");
    }
    return agent;
  }

  async list(query: AgentListQuery): Promise<Page<Agent>> {
    return this.persistence.repos.agents.list({
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
  }

  async update(ctx: RequestContext, id: string, patch: AgentUpdate): Promise<Agent> {
    this.authorizer.assert(ctx.actor, "agent:update");
    return this.persistence.transaction(async (repos) => {
      const current = await repos.agents.lockById(id);
      if (!current) {
        throw notFound("Agent");
      }
      if (current.status === "archived") {
        throw new DomainError("INVALID_TRANSITION", "Archived agents cannot be updated", 409);
      }
      if (patch.modelId) {
        const model = await repos.models.findById(patch.modelId);
        if (!model) {
          throw new DomainError("INVALID_REFERENCE", "Model does not exist", 422);
        }
      }
      if (patch.parentAgentId !== undefined && patch.parentAgentId !== current.parentAgentId) {
        await this.assertParentAgent(repos, id, patch.parentAgentId);
      }
      const updated = await repos.agents.update(id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
        ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
        ...(patch.adapterVersion !== undefined ? { adapterVersion: patch.adapterVersion } : {}),
        ...(patch.memoryNamespace !== undefined ? { memoryNamespace: patch.memoryNamespace } : {}),
        ...(patch.performanceMetrics !== undefined
          ? { performanceMetrics: patch.performanceMetrics }
          : {}),
        ...(patch.parentAgentId !== undefined ? { parentAgentId: patch.parentAgentId } : {}),
      });
      if (patch.name !== undefined) {
        const principal = await repos.principals.findByAgentId(id);
        if (principal) {
          await repos.principals.updateRole(principal.id, updated.role, patch.name);
        }
      }
      await repos.audit.append({
        eventType: "agent.updated",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "agent",
        targetId: id,
        action: "update",
        correlationId: ctx.correlationId,
        beforeState: snapshot(current),
        afterState: snapshot(updated),
        metadata: {},
      });
      return updated;
    });
  }

  async assignRole(ctx: RequestContext, id: string, role: RoleName): Promise<Agent> {
    this.authorizer.assert(ctx.actor, "agent:assign-role");
    assertCanAssignRole(ctx.actor, id, role);
    return this.persistence.transaction(async (repos) => {
      const current = await repos.agents.lockById(id);
      if (!current) {
        throw notFound("Agent");
      }
      if (current.status === "archived") {
        throw new DomainError("INVALID_TRANSITION", "Archived agents cannot change role", 409);
      }
      const principal = await repos.principals.findByAgentId(id);
      if (!principal) {
        throw new DomainError("INVALID_REFERENCE", "Agent principal is missing", 422);
      }
      const updated = await repos.agents.update(id, { role });
      await repos.principals.updateRole(principal.id, role, updated.name);
      await repos.audit.append({
        eventType: "agent.role_changed",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "agent",
        targetId: id,
        action: "assign-role",
        correlationId: ctx.correlationId,
        beforeState: snapshot(current),
        afterState: snapshot(updated),
        metadata: { previousRole: current.role, role },
      });
      return updated;
    });
  }

  private async assertParentAgent(
    repos: Repositories,
    subjectId: string,
    parentAgentId: string | null,
  ): Promise<void> {
    if (parentAgentId === null) {
      return;
    }
    const ancestors = await repos.agents.lockAncestorIds(parentAgentId);
    if (ancestors.length === 0) {
      throw new DomainError("INVALID_REFERENCE", "Parent agent does not exist", 422);
    }
    assertNoHierarchyCycle(subjectId, ancestors);
  }
}
