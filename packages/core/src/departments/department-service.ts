import { randomUUID } from "node:crypto";
import type {
  Department,
  DepartmentCreate,
  DepartmentListQuery,
  DepartmentStatus,
  DepartmentUpdate,
} from "@ai-colony/contracts";
import { SPECIFICATION_VERSION } from "@ai-colony/contracts";
import { parseResourceBudget } from "../budgets/budget.js";
import { snapshot, type RequestContext } from "../context.js";
import { assertNoHierarchyCycle } from "./hierarchy.js";
import { assertDepartmentTransition } from "./transitions.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import { assertCanCreateDepartment } from "../governance/self-protection.js";
import { decodeCursor } from "../pagination.js";
import type { Page, Persistence, Repositories } from "../ports/repositories.js";

export class DepartmentService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
  ) {}

  async create(ctx: RequestContext, input: DepartmentCreate): Promise<Department> {
    this.authorizer.assert(ctx.actor, "department:create");
    assertCanCreateDepartment(ctx.actor, input.departmentType);
    const resourceBudget = parseResourceBudget(input.resourceBudget);
    const id = randomUUID();
    return this.persistence.transaction(async (repos) => {
      await this.assertParent(repos, id, input.parentDepartmentId ?? null);
      const department = await repos.departments.insert({
        id,
        name: input.name,
        slug: input.slug,
        description: input.description,
        purpose: input.purpose,
        parentDepartmentId: input.parentDepartmentId ?? null,
        status: "proposed",
        departmentType: input.departmentType,
        creationSource: "api",
        createdBy: ctx.actor.principalId,
        resourceBudget,
        policyRef: input.policyRef ?? null,
        metadata: input.metadata ?? {},
        specificationVersion: SPECIFICATION_VERSION,
      });
      await this.audit(repos, ctx, "department.created", "create", null, department, {});
      return department;
    });
  }

  async get(id: string): Promise<Department> {
    const department = await this.persistence.repos.departments.findById(id);
    if (!department) {
      throw notFound("Department");
    }
    return department;
  }

  async list(query: DepartmentListQuery): Promise<Page<Department>> {
    return this.persistence.repos.departments.list({
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.departmentType ? { departmentType: query.departmentType } : {}),
      ...(query.parentDepartmentId ? { parentDepartmentId: query.parentDepartmentId } : {}),
    });
  }

  async update(ctx: RequestContext, id: string, patch: DepartmentUpdate): Promise<Department> {
    this.authorizer.assert(ctx.actor, "department:update");
    return this.persistence.transaction(async (repos) => {
      const current = await repos.departments.lockById(id);
      if (!current) {
        throw notFound("Department");
      }
      if (current.status === "archived") {
        throw new DomainError("INVALID_TRANSITION", "Archived departments cannot be updated", 409);
      }
      if (
        patch.parentDepartmentId !== undefined &&
        patch.parentDepartmentId !== current.parentDepartmentId
      ) {
        await this.assertParent(repos, id, patch.parentDepartmentId);
      }
      const updated = await repos.departments.update(id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
        ...(patch.parentDepartmentId !== undefined
          ? { parentDepartmentId: patch.parentDepartmentId }
          : {}),
        ...(patch.policyRef !== undefined ? { policyRef: patch.policyRef } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      });
      await this.audit(repos, ctx, "department.updated", "update", current, updated, {});
      return updated;
    });
  }

  async hierarchy(id: string): Promise<{
    department: Department;
    parent: Department | null;
    children: Department[];
  }> {
    const department = await this.get(id);
    const parent = department.parentDepartmentId
      ? await this.persistence.repos.departments.findById(department.parentDepartmentId)
      : null;
    if (department.parentDepartmentId && !parent) {
      throw new DomainError("INVALID_REFERENCE", "Parent department is missing", 422);
    }
    const children = await this.persistence.repos.departments.listChildren(id);
    return { department, parent, children };
  }

  async listAgents(id: string, query: { limit: number; cursor?: string }) {
    await this.get(id);
    return this.persistence.repos.agents.list({
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
      departmentId: id,
    });
  }

  async activate(ctx: RequestContext, id: string): Promise<Department> {
    this.authorizer.assert(ctx.actor, "department:activate");
    return this.persistence.transaction(async (repos) => {
      const current = await repos.departments.lockById(id);
      if (!current) {
        throw notFound("Department");
      }
      if (current.status === "provisioning") {
        throw new DomainError(
          "APPROVAL_REQUIRED",
          "Initial activation requires an approved department_activate decision",
          409,
        );
      }
      return this.applyStatus(repos, ctx, id, "active", "activate", "department.activated", {});
    });
  }

  async pause(ctx: RequestContext, id: string): Promise<Department> {
    this.authorizer.assert(ctx.actor, "department:update");
    return this.persistence.transaction((repos) =>
      this.applyStatus(repos, ctx, id, "paused", "pause", "department.paused", {}),
    );
  }

  async deprecate(ctx: RequestContext, id: string): Promise<Department> {
    this.authorizer.assert(ctx.actor, "department:update");
    return this.persistence.transaction((repos) =>
      this.applyStatus(repos, ctx, id, "deprecated", "deprecate", "department.deprecated", {}),
    );
  }

  async fail(ctx: RequestContext, id: string, reason: string): Promise<Department> {
    this.authorizer.assert(ctx.actor, "department:update");
    return this.persistence.transaction((repos) =>
      this.applyStatus(repos, ctx, id, "failed", "fail", "department.failed", { reason }),
    );
  }

  async archive(ctx: RequestContext, id: string): Promise<Department> {
    this.authorizer.assert(ctx.actor, "department:archive");
    return this.persistence.transaction(async (repos) => {
      const current = await repos.departments.lockById(id);
      if (!current) {
        throw notFound("Department");
      }
      const children = await repos.departments.listChildren(id);
      const activeChildren = children.filter((child) => child.status !== "archived");
      if (activeChildren.length > 0) {
        throw new DomainError(
          "DEPARTMENT_HAS_CHILDREN",
          "Archive child departments before archiving this department",
          409,
          { childIds: activeChildren.map((child) => child.id) },
        );
      }
      return this.applyStatus(repos, ctx, id, "archived", "archive", "department.archived", {});
    });
  }

  async applyStatus(
    repos: Repositories,
    ctx: RequestContext,
    departmentId: string,
    to: DepartmentStatus,
    action: string,
    eventType: string,
    metadata: Record<string, unknown>,
  ): Promise<Department> {
    const current = await repos.departments.lockById(departmentId);
    if (!current) {
      throw notFound("Department");
    }
    assertDepartmentTransition(current.status, to);
    const updated = await repos.departments.update(departmentId, { status: to });
    await this.audit(repos, ctx, eventType, action, current, updated, metadata);
    return updated;
  }

  private async assertParent(
    repos: Repositories,
    subjectId: string,
    parentId: string | null,
  ): Promise<void> {
    if (parentId === null) {
      return;
    }
    const ancestors = await repos.departments.lockAncestorIds(parentId);
    if (ancestors.length === 0) {
      throw new DomainError("INVALID_REFERENCE", "Parent department does not exist", 422);
    }
    assertNoHierarchyCycle(subjectId, ancestors);
    const parent = await repos.departments.findById(parentId);
    if (!parent) {
      throw new DomainError("INVALID_REFERENCE", "Parent department does not exist", 422);
    }
    if (parent.status === "archived") {
      throw new DomainError("INVALID_PARENT", "Cannot use an archived department as a parent", 409);
    }
  }

  private async audit(
    repos: Repositories,
    ctx: RequestContext,
    eventType: string,
    action: string,
    before: Department | null,
    after: Department,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await repos.audit.append({
      eventType,
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "department",
      targetId: after.id,
      action,
      correlationId: ctx.correlationId,
      beforeState: snapshot(before),
      afterState: snapshot(after),
      metadata,
    });
  }
}
