import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { InferenceProvider } from "../inference/provider.js";
import type { InferenceRoute } from "../objectives/objective-service.js";
import { extractJsonObject } from "../objectives/plan.js";
import type { ObjectiveService } from "../objectives/objective-service.js";
import { isTerminalObjective } from "../objectives/transitions.js";
import type { Persistence } from "../ports/repositories.js";
import { acceptGoalEvidence, goalPrompt, normalizeGoal, redactMessages } from "./policy.js";
import type { AutonomySettings, ColonyGoalRecord, SubgoalRecord } from "./repository.js";

const candidateSchema = z.object({
  decline: z.boolean().optional(),
  reason: z.string().max(2000).optional(),
  goal: z.string().min(1).max(2000).optional(),
  motivation: z.string().min(1).max(2000).optional(),
  evidence: z.array(z.string().min(1).max(500)).max(12).optional(),
  hypotheses: z.array(z.string().min(1).max(500)).max(12).optional(),
  expectedBenefit: z.string().min(1).max(2000).optional(),
  successCriteria: z.array(z.string().min(1).max(500)).max(8).optional(),
  estimatedResources: z.object({ inferenceRequests: z.number().int().positive().max(12) }).optional(),
  departments: z.array(z.string().min(1).max(64)).max(8).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  stopConditions: z.array(z.string().min(1).max(500)).max(8).optional(),
});

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  intervalMs: z.number().int().nonnegative().max(86_400_000).optional(),
  cooldownMs: z.number().int().nonnegative().max(86_400_000).optional(),
  maxActiveGoals: z.number().int().positive().max(8).optional(),
  maxInferenceRequests: z.number().int().nonnegative().max(12).optional(),
  maxDurationMs: z.number().int().positive().max(86_400_000).optional(),
  maxConversations: z.number().int().positive().max(20).optional(),
  maxConversationMessages: z.number().int().positive().max(40).optional(),
  maxConversationTokens: z.number().int().positive().max(100_000).optional(),
  maxConversationParticipants: z.number().int().min(2).max(12).optional(),
  conversationExecutionEnabled: z.boolean().optional(),
  maxConcurrentConversationTurns: z.number().int().min(1).max(4).optional(),
  contextTokenBudget: z.number().int().min(200).max(8_000).optional(),
  conversationSoftTokenBudget: z.number().int().min(1).max(200_000).optional(),
  conversationHardTokenCeiling: z.number().int().min(1).max(200_000).optional(),
  conversationCheckpointTurns: z.number().int().min(1).max(100).optional(),
});

export class AutonomyService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly objectives: ObjectiveService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async settings(ctx: RequestContext): Promise<AutonomySettings> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    return this.persistence.repos.autonomy.settings();
  }

  async update(ctx: RequestContext, patch: unknown): Promise<AutonomySettings> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const parsed = settingsPatchSchema.parse(patch);
    const current = await this.persistence.repos.autonomy.settings();
    const soft = parsed.conversationSoftTokenBudget ?? current.conversationSoftTokenBudget;
    const hard = parsed.conversationHardTokenCeiling ?? current.conversationHardTokenCeiling;
    if (hard < soft) {
      throw new DomainError("VALIDATION_ERROR", "The hard token ceiling must be at least the soft token budget", 422);
    }
    const updated = await this.persistence.repos.autonomy.saveSettings(parsed);
    await this.audit(ctx, "autonomy.updated", "default", parsed);
    return updated;
  }

  async pause(ctx: RequestContext): Promise<AutonomySettings> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const updated = await this.persistence.repos.autonomy.saveSettings({ paused: true });
    await this.audit(ctx, "autonomy.paused", "default", {});
    return updated;
  }

  async resume(ctx: RequestContext): Promise<AutonomySettings> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const updated = await this.persistence.repos.autonomy.saveSettings({ paused: false });
    await this.audit(ctx, "autonomy.resumed", "default", {});
    return updated;
  }

  async goals(ctx: RequestContext): Promise<ColonyGoalRecord[]> {
    this.authorizer.assertAny(ctx.actor, ["autonomy:manage", "objective:admin"]);
    return this.persistence.repos.autonomy.listGoals(50);
  }

  async history(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    return this.persistence.repos.autonomy.listCycles(50);
  }

  async summary(ctx: RequestContext) {
    this.authorizer.assertAny(ctx.actor, ["autonomy:manage", "monitoring:read"]);
    const [goals, conversations, subgoals, cycles] = await Promise.all([
      this.persistence.repos.autonomy.listGoals(100),
      this.persistence.repos.autonomy.listConversations(100),
      this.persistence.repos.objectives.listRuns({ limit: 100, cursor: null }),
      this.persistence.repos.autonomy.listCycles(100),
    ]);
    return {
      goalsSelected: goals.length,
      goalsCompleted: goals.filter((goal) => goal.objectiveStatus === "completed").length,
      goalsAbandoned: goals.filter((goal) => goal.status === "cancelled" || goal.objectiveStatus === "failed" || goal.objectiveStatus === "cancelled").length,
      successCriteriaRecorded: goals.reduce((sum, goal) => sum + goal.successCriteria.length, 0),
      conversationsOpen: conversations.filter((item) => item.status === "open").length,
      conversationsResolved: conversations.filter((item) => item.status === "resolved").length,
      conversationsUnresolved: conversations.filter((item) => item.status === "unresolved").length,
      conversationsTerminated: conversations.filter((item) => item.status === "terminated").length,
      humanObjectives: subgoals.data.filter((run) => run.origin === "human").length,
      autonomousObjectives: subgoals.data.filter((run) => run.origin === "autonomous").length,
      cycles: cycles.length,
    };
  }

  async createSubgoal(ctx: RequestContext, objectiveId: string, input: { description: string; idempotencyKey: string }): Promise<SubgoalRecord> {
    this.authorizer.assert(ctx.actor, "message:publish");
    if (!ctx.actor.agentId || !ctx.actor.departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Only a department agent can create a subgoal", 403);
    }
    const existing = await this.persistence.repos.autonomy.findSubgoalByKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const run = await this.persistence.repos.objectives.getRun(objectiveId);
    if (!run) {
      throw notFound("Objective", objectiveId);
    }
    if (isTerminalObjective(run.status)) {
      throw new DomainError("INVALID_STATE", "A subgoal requires an open objective", 409);
    }
    const description = input.description.trim();
    if (!description || description === run.objective.trim()) {
      throw new DomainError("VALIDATION_ERROR", "A subgoal must be a departmental approach inside the existing objective", 422);
    }
    const row: SubgoalRecord = {
      id: randomUUID(),
      objectiveId,
      departmentId: ctx.actor.departmentId,
      agentId: ctx.actor.agentId,
      description,
      status: "proposed",
      idempotencyKey: input.idempotencyKey,
      createdAt: this.now().toISOString(),
    };
    const { createdAt: _createdAt, ...stored } = row;
    await this.persistence.repos.autonomy.insertSubgoal(stored);
    await this.audit(ctx, "subgoal.created", row.id, { objectiveId, departmentId: row.departmentId });
    return row;
  }

  async subgoals(ctx: RequestContext, objectiveId: string): Promise<SubgoalRecord[]> {
    this.authorizer.assertAny(ctx.actor, ["objective:read", "objective:admin", "message:read"]);
    return this.persistence.repos.autonomy.listSubgoals(objectiveId);
  }

  async cancel(ctx: RequestContext, goalId: string): Promise<ColonyGoalRecord> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const goal = await this.persistence.repos.autonomy.findGoal(goalId);
    if (!goal) {
      throw notFound("ColonyGoal", goalId);
    }
    await this.persistence.repos.autonomy.saveGoal(goalId, "cancelled");
    if (goal.objectiveStatus !== "completed" && goal.objectiveStatus !== "failed" && goal.objectiveStatus !== "cancelled") {
      await this.objectives.cancel(ctx, goal.objectiveId);
    }
    await this.audit(ctx, "goal.cancelled", goalId, { objectiveId: goal.objectiveId });
    const updated = await this.persistence.repos.autonomy.findGoal(goalId);
    if (!updated) {
      throw notFound("ColonyGoal", goalId);
    }
    return updated;
  }

  async runCycle(
    ctx: RequestContext,
    provider: InferenceProvider,
    route: Pick<InferenceRoute, "alias" | "temperature" | "maxOutputTokens" | "timeoutMs">,
  ): Promise<{ outcome: string; goalId: string | null; rationale: string }> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const settings = await this.persistence.repos.autonomy.settings();
    if (!settings.enabled) {
      return this.finish(ctx, "disabled", "Autonomous goal generation is disabled.", null, [], null);
    }
    if (settings.paused) {
      return this.finish(ctx, "paused", "Autonomous goal generation is paused.", null, [], null);
    }
    const waitMs = Math.max(settings.intervalMs, settings.cooldownMs);
    if (settings.lastCycleAt && this.now().getTime() - Date.parse(settings.lastCycleAt) < waitMs) {
      return this.finish(ctx, "cooldown", "The goal-generation cooldown has not elapsed.", null, [], null);
    }
    if (
      settings.maxInferenceRequests < 1 ||
      settings.consumedInferenceRequests + settings.reservedInferenceRequests >= settings.maxInferenceRequests
    ) {
      return this.finish(ctx, "budget", "The colony inference budget is exhausted.", null, [], null);
    }
    const active = await this.persistence.repos.autonomy.countSelectedGoals();
    if (active >= settings.maxActiveGoals) {
      return this.finish(ctx, "at_capacity", "The maximum number of active autonomous goals is already selected.", null, [], null);
    }
    const observations = await this.observations();
    const prompt = goalPrompt(observations);
    const result = await provider.generate({
      requestId: randomUUID(),
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: route.alias,
      messages: prompt,
      temperature: route.temperature,
      maxOutputTokens: route.maxOutputTokens,
      timeoutMs: route.timeoutMs,
      jsonObject: true,
    });
    await this.persistence.repos.autonomy.saveSettings({ lastCycleAt: this.now() });
    let parsed: z.infer<typeof candidateSchema>;
    try {
      parsed = candidateSchema.parse(extractJsonObject(result.text));
    } catch (error) {
      return this.finish(ctx, "rejected", error instanceof Error ? error.message : "The CEO response was not a goal.", null, prompt, result.text);
    }
    if (parsed.decline || !parsed.goal || !parsed.motivation || !parsed.expectedBenefit) {
      return this.finish(ctx, "declined", parsed.reason ?? "The CEO declined to select a goal.", null, prompt, result.text);
    }
    const evidence = parsed.evidence ?? [];
    if (!acceptGoalEvidence(evidence, observations)) {
      return this.finish(ctx, "rejected_evidence", "The CEO cited evidence that was not in the observation summary.", null, prompt, result.text);
    }
    const normalized = normalizeGoal(parsed.goal);
    const duplicate = await this.persistence.repos.autonomy.findActiveByDescription(normalized);
    if (duplicate) {
      return this.finish(ctx, "duplicate", "An active goal already uses this description.", duplicate.id, prompt, result.text);
    }
    const objective = await this.objectives.submit(
      ctx,
      {
        objective: parsed.goal,
        limits: {
          maxInferenceRequests: Math.max(1, Math.min(settings.maxInferenceRequests, parsed.estimatedResources?.inferenceRequests ?? 1)),
          maxDurationMs: settings.maxDurationMs,
        },
      },
      { origin: "autonomous" },
    );
    const goalId = randomUUID();
    await this.persistence.repos.autonomy.insertGoal({
      id: goalId,
      objectiveId: objective.id,
      description: parsed.goal,
      normalizedDescription: normalized,
      motivation: parsed.motivation,
      evidence,
      hypotheses: parsed.hypotheses ?? [],
      expectedBenefit: parsed.expectedBenefit,
      successCriteria: parsed.successCriteria ?? [],
      estimatedInferenceRequests: parsed.estimatedResources?.inferenceRequests ?? 1,
      departments: parsed.departments ?? [],
      priority: parsed.priority ?? "medium",
      stopConditions: parsed.stopConditions ?? [],
      status: "selected",
    });
    return this.finish(ctx, "selected", parsed.motivation, goalId, prompt, result.text);
  }

  private async observations(): Promise<string[]> {
    const page = await this.persistence.repos.objectives.listRuns({ limit: 20, cursor: null });
    const runs = page.data;
    const goals = await this.persistence.repos.autonomy.listGoals(20);
    const conversations = await this.persistence.repos.autonomy.listConversations(20);
    const lines = [
      `completed objectives: ${runs.filter((run) => run.status === "completed").length}`,
      `failed objectives: ${runs.filter((run) => run.status === "failed").length}`,
      `active objectives: ${runs.filter((run) => !isTerminalObjective(run.status)).length}`,
      `selected autonomous goals: ${goals.filter((goal) => goal.status === "selected").length}`,
      `open conversations: ${conversations.filter((item) => item.status === "open").length}`,
      `stored memories: ${await this.persistence.repos.autonomy.countMemories()}`,
    ];
    for (const run of runs.filter((run) => run.status === "failed").slice(0, 5)) {
      lines.push(`failed objective: ${run.objective.slice(0, 160)}`);
    }
    for (const goal of goals.filter((goal) => goal.status === "selected").slice(0, 5)) {
      lines.push(`active goal: ${goal.description.slice(0, 160)}`);
    }
    return lines;
  }

  private async finish(
    ctx: RequestContext,
    outcome: string,
    rationale: string,
    goalId: string | null,
    prompt: Array<{ role: string; content: string }>,
    responseText: string | null,
  ) {
    await this.persistence.repos.autonomy.insertCycle({
      id: randomUUID(),
      outcome,
      rationale,
      goalId,
      prompt: redactMessages(prompt),
      responseText: responseText ? responseText.slice(0, 4000) : null,
    });
    if (outcome === "selected" && goalId) {
      await this.audit(ctx, "goal.selected", goalId, { rationale });
    }
    return { outcome, goalId, rationale };
  }

  private async audit(ctx: RequestContext, eventType: string, targetId: string, metadata: Record<string, unknown>) {
    await this.persistence.repos.audit.append({
      eventType,
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "autonomy",
      targetId,
      action: eventType,
      correlationId: ctx.correlationId,
      beforeState: null,
      afterState: null,
      metadata,
    });
  }
}
