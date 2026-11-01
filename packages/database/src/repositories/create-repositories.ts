import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  or,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { buildPage, DomainError, notFound, type Repositories } from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import {
  agentLifecycleEvents,
  agents,
  approvalRequests,
  auditEvents,
  departments,
  models,
  principals,
} from "../schema/index.js";
import { createMemoryRepository } from "./memories.js";
import { createEvaluationRepository } from "./evaluation.js";
import { createLearningRepository } from "./learning.js";
import { createTrainingRepository } from "./training.js";
import { createMessageRepository } from "./messages.js";
import { createObjectiveRepository } from "./objectives.js";
import {
  mapAgent,
  mapApproval,
  mapAudit,
  mapBudgetRow,
  mapDepartment,
  mapLifecycle,
  mapModel,
  mapPrincipal,
} from "./mappers.js";

function cursorFilter(
  createdAt: AnyColumn,
  id: AnyColumn,
  cursor: { createdAt: Date; id: string } | null,
): SQL | undefined {
  if (!cursor) {
    return undefined;
  }
  return or(
    lt(createdAt, cursor.createdAt),
    and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)),
  );
}

export function createRepositories(db: DbExecutor): Repositories {
  return {
    departments: {
      async insert(input) {
        return guard(async () => {
          const [row] = await db.insert(departments).values(input).returning();
          if (!row) {
            throw new Error("Department insert did not return a row");
          }
          return mapDepartment(row);
        });
      },
      async update(id, patch) {
        return guard(async () => {
          await db
            .update(departments)
            .set({
              updatedAt: new Date(),
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
              ...(patch.parentDepartmentId !== undefined
                ? { parentDepartmentId: patch.parentDepartmentId }
                : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.resourceBudget !== undefined
                ? { resourceBudget: patch.resourceBudget }
                : {}),
              ...(patch.policyRef !== undefined ? { policyRef: patch.policyRef } : {}),
              ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
            })
            .where(eq(departments.id, id));
          const [row] = await db.select().from(departments).where(eq(departments.id, id)).limit(1);
          if (!row) {
            throw notFound("Department");
          }
          return mapDepartment(row);
        });
      },
      async findById(id) {
        const [row] = await db.select().from(departments).where(eq(departments.id, id)).limit(1);
        return row ? mapDepartment(row) : null;
      },
      async lockById(id) {
        const [row] = await db
          .select()
          .from(departments)
          .where(eq(departments.id, id))
          .for("update")
          .limit(1);
        return row ? mapDepartment(row) : null;
      },
      async lockAncestorIds(startId) {
        const ids: string[] = [];
        const seen = new Set<string>();
        let current: string | null = startId;
        while (current !== null) {
          if (seen.has(current)) {
            throw new DomainError("HIERARCHY_CYCLE", "Existing hierarchy contains a cycle", 409);
          }
          if (ids.length >= 64) {
            throw new DomainError("HIERARCHY_TOO_DEEP", "Hierarchy exceeds the maximum depth", 422);
          }
          seen.add(current);
          const [row] = await db
            .select({
              id: departments.id,
              parentDepartmentId: departments.parentDepartmentId,
            })
            .from(departments)
            .where(eq(departments.id, current))
            .for("update")
            .limit(1);
          if (!row) {
            return ids;
          }
          ids.push(row.id);
          current = row.parentDepartmentId;
        }
        return ids;
      },
      async list(filter) {
        const filters = [
          filter.status ? eq(departments.status, filter.status) : undefined,
          filter.departmentType ? eq(departments.departmentType, filter.departmentType) : undefined,
          filter.parentDepartmentId
            ? eq(departments.parentDepartmentId, filter.parentDepartmentId)
            : undefined,
          cursorFilter(departments.createdAt, departments.id, filter.cursor),
        ].filter((item): item is SQL => item !== undefined);
        const rows = await db
          .select()
          .from(departments)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(desc(departments.createdAt), desc(departments.id))
          .limit(filter.limit + 1);
        return buildPage(rows.map(mapDepartment), filter.limit, (department) => ({
          createdAt: department.createdAt,
          id: department.id,
        }));
      },
      async listChildren(parentId) {
        const rows = await db
          .select()
          .from(departments)
          .where(eq(departments.parentDepartmentId, parentId))
          .orderBy(asc(departments.name));
        return rows.map(mapDepartment);
      },
    },
    agents: {
      async insert(input) {
        return guard(async () => {
          await db.insert(agents).values({
            id: input.id,
            departmentId: input.departmentId,
            name: input.name,
            roleName: input.role,
            description: input.description,
            capabilities: input.capabilities,
            modelId: input.modelId,
            adapterVersion: input.adapterVersion,
            memoryNamespace: input.memoryNamespace,
            computeBudget: input.computeBudget,
            parameterBudget: input.parameterBudget,
            status: input.status,
            performanceMetrics: input.performanceMetrics,
            parentAgentId: input.parentAgentId,
            specificationVersion: input.specificationVersion,
          });
          await db.insert(principals).values({
            id: input.principalId,
            principalType: input.principalType,
            displayName: input.name,
            roleName: input.role,
            agentId: input.id,
          });
          const loaded = await loadAgent(db, input.id, false);
          if (!loaded) {
            throw new Error("Inserted agent could not be reloaded");
          }
          return loaded;
        });
      },
      async update(id, patch) {
        return guard(async () => {
          await db
            .update(agents)
            .set({
              updatedAt: new Date(),
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
              ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
              ...(patch.adapterVersion !== undefined
                ? { adapterVersion: patch.adapterVersion }
                : {}),
              ...(patch.memoryNamespace !== undefined
                ? { memoryNamespace: patch.memoryNamespace }
                : {}),
              ...(patch.performanceMetrics !== undefined
                ? { performanceMetrics: patch.performanceMetrics }
                : {}),
              ...(patch.parentAgentId !== undefined ? { parentAgentId: patch.parentAgentId } : {}),
              ...(patch.role !== undefined ? { roleName: patch.role } : {}),
              ...(patch.computeBudget !== undefined ? { computeBudget: patch.computeBudget } : {}),
              ...(patch.parameterBudget !== undefined
                ? { parameterBudget: patch.parameterBudget }
                : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.runtimeOwner !== undefined ? { runtimeOwner: patch.runtimeOwner } : {}),
              ...(patch.runtimeHeartbeatAt !== undefined
                ? {
                    runtimeHeartbeatAt: patch.runtimeHeartbeatAt
                      ? new Date(patch.runtimeHeartbeatAt)
                      : null,
                  }
                : {}),
            })
            .where(eq(agents.id, id));
          const loaded = await loadAgent(db, id, false);
          if (!loaded) {
            throw notFound("Agent");
          }
          return loaded;
        });
      },
      async findById(id) {
        return loadAgent(db, id, false);
      },
      async lockById(id) {
        return loadAgent(db, id, true);
      },
      async lockAncestorIds(startId) {
        const ids: string[] = [];
        const seen = new Set<string>();
        let current: string | null = startId;
        while (current !== null) {
          if (seen.has(current)) {
            throw new DomainError(
              "HIERARCHY_CYCLE",
              "Existing agent hierarchy contains a cycle",
              409,
            );
          }
          if (ids.length >= 64) {
            throw new DomainError(
              "HIERARCHY_TOO_DEEP",
              "Agent hierarchy exceeds the maximum depth",
              422,
            );
          }
          seen.add(current);
          const [row] = await db
            .select({ id: agents.id, parentAgentId: agents.parentAgentId })
            .from(agents)
            .where(eq(agents.id, current))
            .for("update")
            .limit(1);
          if (!row) {
            return ids;
          }
          ids.push(row.id);
          current = row.parentAgentId;
        }
        return ids;
      },
      async list(filter) {
        const filters = [
          filter.departmentId ? eq(agents.departmentId, filter.departmentId) : undefined,
          filter.status ? eq(agents.status, filter.status) : undefined,
          cursorFilter(agents.createdAt, agents.id, filter.cursor),
        ].filter((item): item is SQL => item !== undefined);
        const rows = await db
          .select({ agent: agents, principal: principals })
          .from(agents)
          .innerJoin(principals, eq(principals.agentId, agents.id))
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(desc(agents.createdAt), desc(agents.id))
          .limit(filter.limit + 1);
        return buildPage(
          rows.map((row) => mapAgent(row.agent, row.principal)),
          filter.limit,
          (agent) => ({ createdAt: agent.createdAt, id: agent.id }),
        );
      },
      async listBudgetsByDepartment(departmentId) {
        const rows = await db
          .select({
            id: agents.id,
            computeBudget: agents.computeBudget,
            parameterBudget: agents.parameterBudget,
          })
          .from(agents)
          .where(eq(agents.departmentId, departmentId));
        return rows.map(mapBudgetRow);
      },
      async listStaleRuntimeAgents(cutoff) {
        const rows = await db
          .select({ agent: agents, principal: principals })
          .from(agents)
          .innerJoin(principals, eq(principals.agentId, agents.id))
          .where(
            and(
              inArray(agents.status, ["initializing", "running", "stopping"]),
              or(isNull(agents.runtimeHeartbeatAt), lt(agents.runtimeHeartbeatAt, cutoff)),
            ),
          );
        return rows.map((row) => mapAgent(row.agent, row.principal));
      },
      async touchHeartbeats(agentIds, at) {
        if (agentIds.length === 0) {
          return;
        }
        await db
          .update(agents)
          .set({ runtimeHeartbeatAt: at })
          .where(inArray(agents.id, [...agentIds]));
      },
    },
    principals: {
      async findById(id) {
        const [row] = await db.select().from(principals).where(eq(principals.id, id)).limit(1);
        return row ? mapPrincipal(row) : null;
      },
      async findByAgentId(agentId) {
        const [row] = await db
          .select()
          .from(principals)
          .where(eq(principals.agentId, agentId))
          .limit(1);
        return row ? mapPrincipal(row) : null;
      },
      async insert(input) {
        return guard(async () => {
          const [row] = await db
            .insert(principals)
            .values({
              id: input.id,
              principalType: input.principalType,
              displayName: input.displayName,
              roleName: input.role,
              agentId: input.agentId,
            })
            .returning();
          if (!row) {
            throw new Error("Principal insert did not return a row");
          }
          return mapPrincipal(row);
        });
      },
      async updateRole(id, role, displayName) {
        await db
          .update(principals)
          .set({
            roleName: role,
            ...(displayName !== undefined ? { displayName } : {}),
          })
          .where(eq(principals.id, id));
      },
    },
    models: {
      async insert(input) {
        return guard(async () => {
          const [row] = await db.insert(models).values(input).returning();
          if (!row) {
            throw new Error("Model insert did not return a row");
          }
          return mapModel(row);
        });
      },
      async findById(id) {
        const [row] = await db.select().from(models).where(eq(models.id, id)).limit(1);
        return row ? mapModel(row) : null;
      },
      async maxVersion(lineageId) {
        const [row] = await db
          .select({ value: max(models.version) })
          .from(models)
          .where(eq(models.lineageId, lineageId));
        return row?.value ?? 0;
      },
      async updateStatus(id, status) {
        return guard(async () => {
          await db.update(models).set({ status, updatedAt: new Date() }).where(eq(models.id, id));
          const [row] = await db.select().from(models).where(eq(models.id, id)).limit(1);
          if (!row) {
            throw notFound("Model");
          }
          return mapModel(row);
        });
      },
      async list(filter) {
        const filters = [
          filter.status ? eq(models.status, filter.status) : undefined,
          filter.lineageId ? eq(models.lineageId, filter.lineageId) : undefined,
          cursorFilter(models.createdAt, models.id, filter.cursor),
        ].filter((item): item is SQL => item !== undefined);
        const rows = await db
          .select()
          .from(models)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(desc(models.createdAt), desc(models.id))
          .limit(filter.limit + 1);
        return buildPage(rows.map(mapModel), filter.limit, (model) => ({
          createdAt: model.createdAt,
          id: model.id,
        }));
      },
    },
    approvals: {
      async insert(input) {
        return guard(async () => {
          const [row] = await db
            .insert(approvalRequests)
            .values({
              id: input.id,
              approvalType: input.approvalType,
              targetType: input.targetType,
              targetId: input.targetId,
              payload: input.payload,
              status: "pending",
              requestedBy: input.requestedBy,
            })
            .returning();
          if (!row) {
            throw new Error("Approval insert did not return a row");
          }
          return mapApproval(row);
        });
      },
      async findById(id) {
        const [row] = await db
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, id))
          .limit(1);
        return row ? mapApproval(row) : null;
      },
      async lockById(id) {
        const [row] = await db
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, id))
          .for("update")
          .limit(1);
        return row ? mapApproval(row) : null;
      },
      async list(filter) {
        const filters = [
          filter.status ? eq(approvalRequests.status, filter.status) : undefined,
          filter.approvalType ? eq(approvalRequests.approvalType, filter.approvalType) : undefined,
          filter.targetId ? eq(approvalRequests.targetId, filter.targetId) : undefined,
          cursorFilter(approvalRequests.createdAt, approvalRequests.id, filter.cursor),
        ].filter((item): item is SQL => item !== undefined);
        const rows = await db
          .select()
          .from(approvalRequests)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
          .limit(filter.limit + 1);
        return buildPage(rows.map(mapApproval), filter.limit, (approval) => ({
          createdAt: approval.createdAt,
          id: approval.id,
        }));
      },
      async decide(id, decision) {
        await db
          .update(approvalRequests)
          .set({
            status: decision.status,
            decidedBy: decision.decidedBy,
            decisionReason: decision.decisionReason,
            decidedAt: new Date(),
            consumedAt: decision.consumedAt ? new Date(decision.consumedAt) : null,
          })
          .where(eq(approvalRequests.id, id));
        const [row] = await db
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, id))
          .limit(1);
        if (!row) {
          throw notFound("Approval");
        }
        return mapApproval(row);
      },
    },
    audit: {
      async append(input) {
        const [row] = await db
          .insert(auditEvents)
          .values({
            eventId: randomUUID(),
            eventType: input.eventType,
            actorId: input.actorId,
            actorType: input.actorType,
            targetType: input.targetType,
            targetId: input.targetId,
            action: input.action,
            correlationId: input.correlationId,
            beforeState: input.beforeState,
            afterState: input.afterState,
            metadata: input.metadata,
          })
          .returning();
        if (!row) {
          throw new Error("Audit insert did not return a row");
        }
        return mapAudit(row);
      },
      async list(filter) {
        const filters = [
          filter.targetType ? eq(auditEvents.targetType, filter.targetType) : undefined,
          filter.targetId ? eq(auditEvents.targetId, filter.targetId) : undefined,
          filter.eventType ? eq(auditEvents.eventType, filter.eventType) : undefined,
          cursorFilter(auditEvents.occurredAt, auditEvents.eventId, filter.cursor),
        ].filter((item): item is SQL => item !== undefined);
        const rows = await db
          .select()
          .from(auditEvents)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.eventId))
          .limit(filter.limit + 1);
        return buildPage(rows.map(mapAudit), filter.limit, (event) => ({
          createdAt: event.timestamp,
          id: event.eventId,
        }));
      },
    },
    lifecycle: {
      async append(input) {
        const [row] = await db
          .insert(agentLifecycleEvents)
          .values({
            agentId: input.agentId,
            fromStatus: input.fromStatus,
            toStatus: input.toStatus,
            reason: input.reason,
            actorId: input.actorId,
            actorType: input.actorType,
            correlationId: input.correlationId,
          })
          .returning();
        if (!row) {
          throw new Error("Lifecycle insert did not return a row");
        }
        return mapLifecycle(row);
      },
      async listByAgent(agentId, filter) {
        const filters = [
          eq(agentLifecycleEvents.agentId, agentId),
          cursorFilter(agentLifecycleEvents.createdAt, agentLifecycleEvents.id, filter.cursor),
        ].filter((item): item is SQL => item !== undefined);
        const rows = await db
          .select()
          .from(agentLifecycleEvents)
          .where(and(...filters))
          .orderBy(desc(agentLifecycleEvents.createdAt), desc(agentLifecycleEvents.id))
          .limit(filter.limit + 1);
        return buildPage(rows.map(mapLifecycle), filter.limit, (event) => ({
          createdAt: event.createdAt,
          id: event.id,
        }));
      },
    },
    messages: createMessageRepository(db),
    objectives: createObjectiveRepository(db),
    memories: createMemoryRepository(db),
    training: createTrainingRepository(db),
    evaluation: createEvaluationRepository(db),
    learning: createLearningRepository(db),
  };
}

async function loadAgent(
  db: DbExecutor,
  id: string,
  lock: boolean,
): Promise<ReturnType<typeof mapAgent> | null> {
  const query = db
    .select({ agent: agents, principal: principals })
    .from(agents)
    .innerJoin(principals, eq(principals.agentId, agents.id))
    .where(eq(agents.id, id))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  const row = rows[0];
  return row ? mapAgent(row.agent, row.principal) : null;
}
