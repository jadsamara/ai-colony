import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Agent,
  Approval,
  ApprovalDecision,
  ApprovalListQuery,
  ApprovalRequest,
  Department,
} from "@ai-colony/contracts";
import { parameterBudgetSchema, resourceBudgetSchema } from "@ai-colony/contracts";
import { snapshot, type RequestContext } from "../context.js";
import {
  assertAgentBudgetWithinDepartment,
  assertDepartmentBudgetCoversAgents,
  parseParameterBudget,
  parseResourceBudget,
} from "../budgets/budget.js";
import type { DepartmentService } from "../departments/department-service.js";
import { isPermanentDepartmentType } from "../departments/transitions.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import {
  assertCanDecideApproval,
  assertNotSelfBudgetChange,
} from "../governance/self-protection.js";
import { decodeCursor } from "../pagination.js";
import type { Page, Persistence, Repositories } from "../ports/repositories.js";

const departmentBudgetPayloadSchema = z.object({ resourceBudget: resourceBudgetSchema }).strict();
const agentBudgetPayloadSchema = z
  .object({
    computeBudget: resourceBudgetSchema,
    parameterBudget: parameterBudgetSchema,
  })
  .strict();

export interface ApprovalResult {
  approval: Approval;
  department: Department | null;
  agent: Agent | null;
}

export class ApprovalService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly departments: DepartmentService,
  ) {}

  async request(ctx: RequestContext, input: ApprovalRequest): Promise<ApprovalResult> {
    this.authorizer.assert(ctx.actor, "approval:request");
    if (input.approvalType === "budget_change") {
      this.authorizer.assert(ctx.actor, "budget:request");
    }
    return this.persistence.transaction(async (repos) => {
      if (
        input.approvalType === "department_create" ||
        input.approvalType === "department_activate"
      ) {
        const department = await this.requireDepartmentStatus(
          repos,
          input.targetId,
          input.approvalType === "department_create" ? "proposed" : "provisioning",
        );
        const approval = await repos.approvals.insert({
          id: randomUUID(),
          approvalType: input.approvalType,
          targetType: "department",
          targetId: input.targetId,
          payload: {},
          requestedBy: ctx.actor.principalId,
        });
        await this.auditDecisionRequest(repos, ctx, approval);
        return { approval, department, agent: null };
      }

      if (input.targetType === "department") {
        const department = await repos.departments.lockById(input.targetId);
        if (!department) {
          throw notFound("Department");
        }
        const resourceBudget = parseResourceBudget(input.resourceBudget);
        const agents = await repos.agents.listBudgetsByDepartment(department.id);
        assertDepartmentBudgetCoversAgents(resourceBudget, agents);
        const approval = await repos.approvals.insert({
          id: randomUUID(),
          approvalType: "budget_change",
          targetType: "department",
          targetId: department.id,
          payload: { resourceBudget },
          requestedBy: ctx.actor.principalId,
        });
        await this.auditDecisionRequest(repos, ctx, approval);
        return { approval, department, agent: null };
      }

      const agent = await repos.agents.lockById(input.targetId);
      if (!agent) {
        throw notFound("Agent");
      }
      const department = await repos.departments.lockById(agent.departmentId);
      if (!department) {
        throw notFound("Department");
      }
      const computeBudget = parseResourceBudget(input.computeBudget);
      const parameterBudget = parseParameterBudget(input.parameterBudget);
      assertAgentBudgetWithinDepartment(computeBudget, parameterBudget, department.resourceBudget);
      const approval = await repos.approvals.insert({
        id: randomUUID(),
        approvalType: "budget_change",
        targetType: "agent",
        targetId: agent.id,
        payload: { computeBudget, parameterBudget },
        requestedBy: ctx.actor.principalId,
      });
      await this.auditDecisionRequest(repos, ctx, approval);
      return { approval, department: null, agent };
    });
  }

  async decide(
    ctx: RequestContext,
    id: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalResult> {
    return this.persistence.transaction(async (repos) => {
      const approval = await repos.approvals.lockById(id);
      if (!approval) {
        throw notFound("Approval");
      }
      if (approval.status !== "pending") {
        throw new DomainError(
          "APPROVAL_NOT_PENDING",
          "Only pending approvals can be decided",
          409,
          {
            status: approval.status,
          },
        );
      }

      const loaded = await this.loadTarget(repos, approval.targetType, approval.targetId);
      assertCanDecideApproval(
        ctx.actor,
        approval,
        approval.approvalType === "budget_change"
          ? null
          : (loaded.department?.departmentType ?? null),
      );
      if (approval.approvalType === "budget_change") {
        this.authorizer.assert(ctx.actor, "budget:approve");
        assertNotSelfBudgetChange(ctx.actor, {
          targetType: approval.targetType,
          targetId: approval.targetId,
        });
      } else if (loaded.department && isPermanentDepartmentType(loaded.department.departmentType)) {
        this.authorizer.assert(ctx.actor, "approval:decide:permanent");
      } else {
        this.authorizer.assert(ctx.actor, "approval:decide");
      }

      if (decision.decision === "rejected") {
        const decided = await repos.approvals.decide(approval.id, {
          status: "rejected",
          decidedBy: ctx.actor.principalId,
          decisionReason: decision.reason,
          consumedAt: null,
        });
        await this.auditDecided(repos, ctx, approval, decided);
        return { approval: decided, department: loaded.department, agent: loaded.agent };
      }

      let department = loaded.department;
      let agent = loaded.agent;
      if (approval.approvalType === "department_create") {
        department = await this.departments.applyStatus(
          repos,
          ctx,
          approval.targetId,
          "provisioning",
          "provision",
          "department.provisioned",
          { approvalId: approval.id },
        );
      } else if (approval.approvalType === "department_activate") {
        department = await this.departments.applyStatus(
          repos,
          ctx,
          approval.targetId,
          "active",
          "activate",
          "department.activated",
          { approvalId: approval.id },
        );
      } else if (approval.targetType === "department" && department) {
        const payload = parseStoredPayload(departmentBudgetPayloadSchema, approval.payload);
        const resourceBudget = parseResourceBudget(payload.resourceBudget);
        const agents = await repos.agents.listBudgetsByDepartment(department.id);
        assertDepartmentBudgetCoversAgents(resourceBudget, agents);
        const updated = await repos.departments.update(department.id, { resourceBudget });
        await this.auditBudget(repos, ctx, "department", department.id, department, updated);
        department = updated;
      } else if (approval.targetType === "agent" && agent) {
        const payload = parseStoredPayload(agentBudgetPayloadSchema, approval.payload);
        const computeBudget = parseResourceBudget(payload.computeBudget);
        const parameterBudget = parseParameterBudget(payload.parameterBudget);
        const owner = await repos.departments.lockById(agent.departmentId);
        if (!owner) {
          throw notFound("Department");
        }
        assertAgentBudgetWithinDepartment(computeBudget, parameterBudget, owner.resourceBudget);
        const updated = await repos.agents.update(agent.id, { computeBudget, parameterBudget });
        await this.auditBudget(repos, ctx, "agent", agent.id, agent, updated);
        agent = updated;
      }

      const decided = await repos.approvals.decide(approval.id, {
        status: "approved",
        decidedBy: ctx.actor.principalId,
        decisionReason: decision.reason,
        consumedAt: new Date().toISOString(),
      });
      await this.auditDecided(repos, ctx, approval, decided);
      return { approval: decided, department, agent };
    });
  }

  async get(ctx: RequestContext, id: string): Promise<Approval> {
    this.assertCanRead(ctx);
    const approval = await this.persistence.repos.approvals.findById(id);
    if (!approval) {
      throw notFound("Approval");
    }
    return approval;
  }

  async list(ctx: RequestContext, query: ApprovalListQuery): Promise<Page<Approval>> {
    this.assertCanRead(ctx);
    return this.persistence.repos.approvals.list({
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.approvalType ? { approvalType: query.approvalType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
    });
  }

  private assertCanRead(ctx: RequestContext): void {
    this.authorizer.assertAny(ctx.actor, ["audit:read", "approval:request", "approval:decide"]);
  }

  private async requireDepartmentStatus(
    repos: Repositories,
    departmentId: string,
    status: Department["status"],
  ): Promise<Department> {
    const department = await repos.departments.lockById(departmentId);
    if (!department) {
      throw notFound("Department");
    }
    if (department.status !== status) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `Department must be ${status} before this approval can be requested`,
        409,
        { status: department.status, expected: status },
      );
    }
    return department;
  }

  private async loadTarget(
    repos: Repositories,
    targetType: Approval["targetType"],
    targetId: string,
  ): Promise<{ department: Department | null; agent: Agent | null }> {
    if (targetType === "department") {
      const department = await repos.departments.lockById(targetId);
      if (!department) {
        throw notFound("Department");
      }
      return { department, agent: null };
    }
    const agent = await repos.agents.lockById(targetId);
    if (!agent) {
      throw notFound("Agent");
    }
    return { department: null, agent };
  }

  private async auditDecisionRequest(
    repos: Repositories,
    ctx: RequestContext,
    approval: Approval,
  ): Promise<void> {
    await repos.audit.append({
      eventType: "approval.requested",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "approval",
      targetId: approval.id,
      action: "request",
      correlationId: ctx.correlationId,
      beforeState: null,
      afterState: snapshot(approval),
      metadata: { approvalType: approval.approvalType, subjectId: approval.targetId },
    });
  }

  private async auditDecided(
    repos: Repositories,
    ctx: RequestContext,
    before: Approval,
    after: Approval,
  ): Promise<void> {
    await repos.audit.append({
      eventType: "approval.decided",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "approval",
      targetId: after.id,
      action: "decide",
      correlationId: ctx.correlationId,
      beforeState: snapshot(before),
      afterState: snapshot(after),
      metadata: { decision: after.status },
    });
  }

  private async auditBudget(
    repos: Repositories,
    ctx: RequestContext,
    targetType: string,
    targetId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await repos.audit.append({
      eventType: "budget.changed",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType,
      targetId,
      action: "update-budget",
      correlationId: ctx.correlationId,
      beforeState: snapshot(before),
      afterState: snapshot(after),
      metadata: { scope: "definition-only" },
    });
  }
}

function parseStoredPayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_ERROR", "Stored approval payload is invalid", 422);
  }
  return parsed.data;
}
