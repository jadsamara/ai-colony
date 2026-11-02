import { and, asc, desc, eq, inArray, lt, max, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type {
  AgentStatus,
  ObjectiveStatus,
  RoleName,
  RuntimeStatus,
  TaskStatus,
  TaskType,
} from "@ai-colony/contracts";
import {
  buildPage,
  notFound,
  type DecodedCursor,
  type ObjectiveRepository,
  type ObjectiveRun,
  type ObjectiveTaskRecord,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import {
  agents,
  departments,
  inferenceRequests,
  inferenceUsage,
  modelRuntimes,
  models,
  objectivePlans,
  objectiveRuns,
  objectiveTasks,
  principals,
  taskAssignments,
  taskResults,
  workerHeartbeats,
  workflowEvents,
} from "../schema/index.js";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapRun(row: typeof objectiveRuns.$inferSelect): ObjectiveRun {
  return {
    id: row.id,
    submitterPrincipalId: row.submitterPrincipalId,
    objective: row.objectiveText,
    status: row.status as ObjectiveStatus,
    correlationId: row.correlationId,
    failureReason: row.failureReason,
    finalOutput: row.finalOutput,
    executionAuthorized: row.executionAuthorized,
    planCorrections: row.planCorrections,
    memoryProfile: row.memoryProfile as "shared" | "split",
    primaryModelId: row.primaryModelId,
    operationalModelId: row.operationalModelId,
    limits: {
      maxInferenceRequests: row.maxInferenceRequests,
      maxOutputTokens: row.maxOutputTokens,
      maxEstimatedTokens: row.maxEstimatedTokens,
      maxTaskAttempts: row.maxTaskAttempts,
      maxConcurrentTasks: row.maxConcurrentTasks,
      maxDurationMs: row.maxDurationMs,
    },
    consumedRequests: row.consumedRequests,
    reservedRequests: row.reservedRequests,
    consumedInputTokens: row.consumedInputTokens,
    consumedOutputTokens: row.consumedOutputTokens,
    estimatedInputTokens: row.estimatedInputTokens,
    estimatedOutputTokens: row.estimatedOutputTokens,
    reservedOutputTokens: row.reservedOutputTokens,
    estimatedCostUsdMicros: row.estimatedCostUsdMicros,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapInference(row: typeof inferenceRequests.$inferSelect) {
  return {
    id: row.id,
    objectiveId: row.objectiveId,
    taskId: row.taskId,
    attempt: row.attempt,
    purpose: row.purpose,
    registryModelId: row.registryModelId,
    intendedModelId: row.intendedModelId,
    requestedAlias: row.requestedAlias,
    status: row.status,
    reservedOutputTokens: row.reservedOutputTokens,
    idempotencyKey: row.idempotencyKey,
    responseText: row.responseText,
    error: row.error,
    leaseOwner: row.leaseOwner,
    leaseUntil: iso(row.leaseUntil),
  };
}

function mapTask(
  row: typeof objectiveTasks.$inferSelect,
  objectiveCreatedAt: Date,
): ObjectiveTaskRecord {
  return {
    id: row.id,
    objectiveId: row.objectiveId,
    localId: row.localId,
    departmentId: row.departmentId,
    departmentSlug: row.departmentSlug as TaskType,
    taskType: row.taskType as TaskType,
    objective: row.objectiveText,
    expectedOutput: row.expectedOutput,
    dependsOn: row.dependsOn,
    status: row.status as TaskStatus,
    attempt: row.attempt,
    assignedAgentId: row.assignedAgentId,
    requestMessageId: row.requestMessageId,
    error: row.error,
    resultSummary: row.resultSummary,
    deadline: iso(row.deadline),
    leaseOwner: row.leaseOwner,
    leaseUntil: iso(row.leaseUntil),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    objectiveCreatedAt: objectiveCreatedAt.toISOString(),
  };
}

export function createObjectiveRepository(db: DbExecutor): ObjectiveRepository {
  return {
    async insertRun(input) {
      const [row] = await guard(() =>
        db
          .insert(objectiveRuns)
          .values({
            id: input.id,
            submitterPrincipalId: input.submitterPrincipalId,
            objectiveText: input.objective,
            status: "submitted",
            correlationId: input.correlationId,
            executionAuthorized: input.executionAuthorized,
            memoryProfile: input.memoryProfile,
            primaryModelId: input.primaryModelId,
            operationalModelId: input.operationalModelId,
            maxInferenceRequests: input.limits.maxInferenceRequests,
            maxOutputTokens: input.limits.maxOutputTokens,
            maxEstimatedTokens: input.limits.maxEstimatedTokens,
            maxTaskAttempts: input.limits.maxTaskAttempts,
            maxConcurrentTasks: input.limits.maxConcurrentTasks,
            maxDurationMs: input.limits.maxDurationMs,
          })
          .returning(),
      );
      if (!row) {
        throw new Error("Objective insert did not return a row");
      }
      return mapRun(row);
    },
    async getRun(id) {
      const [row] = await db.select().from(objectiveRuns).where(eq(objectiveRuns.id, id)).limit(1);
      return row ? mapRun(row) : null;
    },
    async lockRun(id) {
      const [row] = await db
        .select()
        .from(objectiveRuns)
        .where(eq(objectiveRuns.id, id))
        .limit(1)
        .for("update");
      return row ? mapRun(row) : null;
    },
    async saveRun(id, patch) {
      const [row] = await db
        .update(objectiveRuns)
        .set({
          updatedAt: new Date(),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
          ...(patch.finalOutput !== undefined ? { finalOutput: patch.finalOutput } : {}),
          ...(patch.executionAuthorized !== undefined
            ? { executionAuthorized: patch.executionAuthorized }
            : {}),
          ...(patch.planCorrections !== undefined ? { planCorrections: patch.planCorrections } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        })
        .where(eq(objectiveRuns.id, id))
        .returning();
      if (!row) {
        throw notFound("Objective", id);
      }
      return mapRun(row);
    },
    async listRuns(filter) {
      const filters = [
        filter.status ? eq(objectiveRuns.status, filter.status) : undefined,
        filter.submitterPrincipalId
          ? eq(objectiveRuns.submitterPrincipalId, filter.submitterPrincipalId)
          : undefined,
        cursor(objectiveRuns.createdAt, objectiveRuns.id, filter.cursor),
      ].filter((item) => item !== undefined);
      const rows = await db
        .select()
        .from(objectiveRuns)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(objectiveRuns.createdAt), desc(objectiveRuns.id))
        .limit(filter.limit + 1);
      return buildPage(rows.map(mapRun), filter.limit, (run) => ({
        createdAt: run.createdAt,
        id: run.id,
      }));
    },
    async insertPlan(input) {
      await guard(() =>
        db.insert(objectivePlans).values({
          id: input.id,
          objectiveId: input.objectiveId,
          version: input.version,
          body: input.body,
          valid: input.valid,
          errors: input.errors,
        }),
      );
    },
    async latestPlan(objectiveId) {
      const [row] = await db
        .select()
        .from(objectivePlans)
        .where(eq(objectivePlans.objectiveId, objectiveId))
        .orderBy(desc(objectivePlans.version))
        .limit(1);
      return row ? { version: row.version, valid: row.valid, body: row.body, errors: row.errors } : null;
    },
    async insertTasks(tasks) {
      if (tasks.length === 0) {
        return;
      }
      await guard(() =>
        db.insert(objectiveTasks).values(
          tasks.map((task) => ({
            id: task.id,
            objectiveId: task.objectiveId,
            localId: task.localId,
            departmentId: task.departmentId,
            departmentSlug: task.departmentSlug,
            taskType: task.taskType,
            objectiveText: task.objective,
            expectedOutput: task.expectedOutput,
            dependsOn: task.dependsOn,
            status: "pending",
            attempt: 1,
          })),
        ),
      );
    },
    async listTasks(objectiveId) {
      const rows = await db
        .select({ task: objectiveTasks, objectiveCreatedAt: objectiveRuns.createdAt })
        .from(objectiveTasks)
        .innerJoin(objectiveRuns, eq(objectiveRuns.id, objectiveTasks.objectiveId))
        .where(objectiveId ? eq(objectiveTasks.objectiveId, objectiveId) : undefined)
        .orderBy(asc(objectiveTasks.createdAt), asc(objectiveTasks.id));
      return rows.map((row) => mapTask(row.task, row.objectiveCreatedAt));
    },
    async lockTask(id) {
      const [row] = await db
        .select({ task: objectiveTasks, objectiveCreatedAt: objectiveRuns.createdAt })
        .from(objectiveTasks)
        .innerJoin(objectiveRuns, eq(objectiveRuns.id, objectiveTasks.objectiveId))
        .where(eq(objectiveTasks.id, id))
        .limit(1)
        .for("update");
      return row ? mapTask(row.task, row.objectiveCreatedAt) : null;
    },
    async saveTask(id, patch) {
      const [row] = await db
        .update(objectiveTasks)
        .set({
          updatedAt: new Date(),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
          ...(patch.assignedAgentId !== undefined ? { assignedAgentId: patch.assignedAgentId } : {}),
          ...(patch.requestMessageId !== undefined ? { requestMessageId: patch.requestMessageId } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.resultSummary !== undefined ? { resultSummary: patch.resultSummary } : {}),
          ...(patch.deadline !== undefined ? { deadline: patch.deadline } : {}),
          ...(patch.leaseOwner !== undefined ? { leaseOwner: patch.leaseOwner } : {}),
          ...(patch.leaseUntil !== undefined ? { leaseUntil: patch.leaseUntil } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        })
        .where(eq(objectiveTasks.id, id))
        .returning();
      if (!row) {
        throw notFound("ObjectiveTask", id);
      }
    },
    async insertAssignment(input) {
      await db.insert(taskAssignments).values(input);
    },
    async insertResult(input) {
      await guard(() => db.insert(taskResults).values(input));
    },
    async findResult(taskId, attempt) {
      const [row] = await db
        .select({ id: taskResults.id })
        .from(taskResults)
        .where(and(eq(taskResults.taskId, taskId), eq(taskResults.attempt, attempt)))
        .limit(1);
      return row ?? null;
    },
    async insertInference(input) {
      const rows = await db
        .insert(inferenceRequests)
        .values({
          id: input.id,
          objectiveId: input.objectiveId,
          taskId: input.taskId,
          attempt: input.attempt,
          purpose: input.purpose,
          registryModelId: input.registryModelId,
          intendedModelId: input.intendedModelId,
          requestedAlias: input.requestedAlias,
          status: "running",
          reservedOutputTokens: input.reservedOutputTokens,
          idempotencyKey: input.idempotencyKey,
          leaseOwner: input.leaseOwner,
          leaseUntil: input.leaseUntil,
        })
        .onConflictDoNothing({ target: inferenceRequests.idempotencyKey })
        .returning({ id: inferenceRequests.id });
      return rows[0] ? "created" : "exists";
    },
    async getInferenceById(id) {
      const [row] = await db.select().from(inferenceRequests).where(eq(inferenceRequests.id, id)).limit(1);
      return row ? mapInference(row) : null;
    },
    async reopenInference(id, leaseOwner, leaseUntil) {
      await db
        .update(inferenceRequests)
        .set({ status: "running", error: null, responseText: null, leaseOwner, leaseUntil, completedAt: null })
        .where(eq(inferenceRequests.id, id));
    },
    async getInference(key) {
      const [row] = await db
        .select()
        .from(inferenceRequests)
        .where(eq(inferenceRequests.idempotencyKey, key))
        .limit(1);
      return row ? mapInference(row) : null;
    },
    async finishInference(id, patch) {
      await db
        .update(inferenceRequests)
        .set({
          status: patch.status,
          responseText: patch.responseText,
          error: patch.error,
          completedAt: new Date(),
          leaseUntil: null,
        })
        .where(eq(inferenceRequests.id, id));
    },
    async insertUsage(input) {
      await db.insert(inferenceUsage).values(input);
    },
    async reserve(input) {
      const rows = await db.execute(sql`
        update objective_runs
        set reserved_requests = reserved_requests + 1,
            reserved_output_tokens = reserved_output_tokens + ${input.outputTokens},
            updated_at = now()
        where id = ${input.objectiveId}
          and consumed_requests + reserved_requests + 1 <= max_inference_requests
          and consumed_output_tokens + estimated_output_tokens + reserved_output_tokens + ${input.outputTokens} <= max_output_tokens
          and estimated_input_tokens + estimated_output_tokens + ${input.estimatedTokens} <= max_estimated_tokens
        returning id
      `);
      return rows.length > 0;
    },
    async releaseReservation(objectiveId, outputTokens) {
      await db.execute(sql`
        update objective_runs
        set reserved_requests = greatest(reserved_requests - 1, 0),
            reserved_output_tokens = greatest(reserved_output_tokens - ${outputTokens}, 0),
            updated_at = now()
        where id = ${objectiveId}
      `);
    },
    async reconcile(input) {
      await db.execute(sql`
        update objective_runs
        set reserved_requests = greatest(reserved_requests - 1, 0),
            reserved_output_tokens = greatest(reserved_output_tokens - ${input.reservedOutputTokens}, 0),
            consumed_requests = consumed_requests + 1,
            consumed_input_tokens = consumed_input_tokens + ${input.observedInputTokens},
            consumed_output_tokens = consumed_output_tokens + ${input.observedOutputTokens},
            estimated_input_tokens = estimated_input_tokens + ${input.estimatedInputTokens},
            estimated_output_tokens = estimated_output_tokens + ${input.estimatedOutputTokens},
            estimated_cost_usd_micros = case
              when ${input.estimatedCostUsdMicros}::bigint is null then estimated_cost_usd_micros
              else coalesce(estimated_cost_usd_micros, 0) + ${input.estimatedCostUsdMicros ?? 0}
            end,
            updated_at = now()
        where id = ${input.objectiveId}
      `);
    },
    async appendEvent(input) {
      await db.insert(workflowEvents).values(input);
    },
    async listEvents(filter) {
      const filters = [
        eq(workflowEvents.objectiveId, filter.objectiveId),
        cursor(workflowEvents.createdAt, workflowEvents.id, filter.cursor),
      ].filter((item) => item !== undefined);
      const rows = await db
        .select()
        .from(workflowEvents)
        .where(and(...filters))
        .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
        .limit(filter.limit + 1);
      return buildPage(
        rows.map((row) => ({
          id: row.id,
          objectiveId: row.objectiveId,
          eventType: row.eventType,
          summary: row.summary,
          createdAt: row.createdAt.toISOString(),
        })),
        filter.limit,
        (event) => ({ createdAt: event.createdAt, id: event.id }),
      );
    },
    async hasEvent(objectiveId, eventType) {
      const filters = [
        eq(workflowEvents.eventType, eventType),
        objectiveId ? eq(workflowEvents.objectiveId, objectiveId) : undefined,
      ].filter((item) => item !== undefined);
      const [row] = await db
        .select({ id: workflowEvents.id })
        .from(workflowEvents)
        .where(and(...filters))
        .limit(1);
      return Boolean(row);
    },
    async counts() {
      const objectives = await db
        .select({ status: objectiveRuns.status, count: sql<number>`count(*)::int` })
        .from(objectiveRuns)
        .groupBy(objectiveRuns.status);
      const tasks = await db
        .select({ status: objectiveTasks.status, count: sql<number>`count(*)::int` })
        .from(objectiveTasks)
        .groupBy(objectiveTasks.status);
      const [usage] = await db
        .select({
          requests: sql<number>`count(*)::int`,
          observed: sql<number>`coalesce(sum(${inferenceUsage.outputTokens}), 0)::int`,
          cost: sql<number | null>`sum(${inferenceUsage.estimatedCostUsdMicros})::bigint`,
          unavailable: sql<number>`count(*) filter (where ${inferenceUsage.tokenSource} = 'unavailable')::int`,
        })
        .from(inferenceUsage);
      const [estimated] = await db
        .select({
          tokens: sql<number>`coalesce(sum(${objectiveRuns.estimatedOutputTokens}), 0)::int`,
        })
        .from(objectiveRuns);
      return {
        objectives: objectives.map((row) => ({ status: row.status, count: Number(row.count) })),
        tasks: tasks.map((row) => ({ status: row.status, count: Number(row.count) })),
        inferenceRequests: Number(usage?.requests ?? 0),
        observedOutputTokens: Number(usage?.observed ?? 0),
        estimatedOutputTokens: Number(estimated?.tokens ?? 0),
        unavailableUsage: Number(usage?.unavailable ?? 0),
        estimatedCostUsdMicros: usage?.cost === null || usage?.cost === undefined ? null : Number(usage.cost),
      };
    },
    async upsertRuntime(input) {
      await db
        .insert(modelRuntimes)
        .values({
          modelId: input.modelId,
          runtimeStatus: input.runtimeStatus,
          endpointUrl: input.endpointUrl,
          expectedAlias: input.expectedAlias,
          loadedModelId: input.loadedModelId,
          lastError: input.lastError,
          probedAt: input.probedAt,
        })
        .onConflictDoUpdate({
          target: modelRuntimes.modelId,
          set: {
            runtimeStatus: input.runtimeStatus,
            endpointUrl: input.endpointUrl,
            expectedAlias: input.expectedAlias,
            loadedModelId: input.loadedModelId,
            lastError: input.lastError,
            probedAt: input.probedAt,
            updatedAt: new Date(),
          },
        });
    },
    async listRuntimes() {
      const rows = await db
        .select({ model: models, runtime: modelRuntimes })
        .from(models)
        .leftJoin(modelRuntimes, eq(modelRuntimes.modelId, models.id))
        .orderBy(asc(models.displayName));
      return rows.map((row) => ({
        modelId: row.model.id,
        displayName: row.model.displayName,
        registryStatus: row.model.status,
        runtimeStatus: (row.runtime?.runtimeStatus ?? "not_deployed") as RuntimeStatus,
        expectedAlias: row.runtime?.expectedAlias ?? null,
        loadedModelId: row.runtime?.loadedModelId ?? null,
        endpointUrl: row.runtime?.endpointUrl ?? null,
        lastError: row.runtime?.lastError ?? null,
        probedAt: iso(row.runtime?.probedAt ?? null),
      }));
    },
    async latestCompletedInferenceAt() {
      const [row] = await db
        .select({ completedAt: max(inferenceRequests.completedAt) })
        .from(inferenceRequests)
        .where(eq(inferenceRequests.status, "completed"));
      return row?.completedAt ?? null;
    },
    async heartbeat(input) {
      await db
        .insert(workerHeartbeats)
        .values(input)
        .onConflictDoUpdate({
          target: workerHeartbeats.workerId,
          set: { role: input.role, beatAt: input.beatAt, detail: input.detail },
        });
    },
    async listHeartbeats() {
      const rows = await db.select().from(workerHeartbeats).orderBy(asc(workerHeartbeats.workerId));
      return rows.map((row) => ({
        workerId: row.workerId,
        role: row.role,
        beatAt: row.beatAt.toISOString(),
        detail: row.detail,
      }));
    },
    async findDepartmentBySlug(slug) {
      const [row] = await db
        .select({ id: departments.id, slug: departments.slug, status: departments.status })
        .from(departments)
        .where(eq(departments.slug, slug))
        .limit(1);
      return row ?? null;
    },
    async listEligibleAgents(departmentId) {
      return loadAgents(
        db,
        and(eq(agents.departmentId, departmentId), inArray(agents.status, ["idle", "running", "paused"])),
      );
    },
    async findAgent(id) {
      const rows = await loadAgents(db, eq(agents.id, id));
      return rows[0] ?? null;
    },
  };
}

function cursor(createdAt: AnyColumn, id: AnyColumn, value: DecodedCursor | null): SQL | undefined {
  if (!value) {
    return undefined;
  }
  return or(lt(createdAt, value.createdAt), and(eq(createdAt, value.createdAt), lt(id, value.id)));
}

async function loadAgents(db: DbExecutor, where: SQL | undefined) {
  const rows = await db
    .select({ agent: agents, principalId: principals.id })
    .from(agents)
    .innerJoin(principals, eq(principals.agentId, agents.id))
    .where(where)
    .orderBy(asc(agents.createdAt));
  return rows.map((row) => ({
    id: row.agent.id,
    principalId: row.principalId,
    departmentId: row.agent.departmentId,
    role: row.agent.roleName as RoleName,
    status: row.agent.status as AgentStatus,
    name: row.agent.name,
  }));
}
