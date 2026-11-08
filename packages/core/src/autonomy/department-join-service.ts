import { randomUUID } from "node:crypto";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import { InferenceError, type InferenceProvider, type InferenceResult } from "../inference/provider.js";
import { estimateCostUsdMicros, estimateTokens, type CostRates, type TokenUsage } from "../inference/usage.js";
import { extractJsonObject } from "../objectives/plan.js";
import type { InferenceRoute } from "../objectives/objective-service.js";
import type { Persistence } from "../ports/repositories.js";
import { selectConversationInference } from "./conversation-routing.js";
import {
  ORCHESTRATION_JOIN_SCHEMA,
  buildJoinTaskBrief,
  orchestrationJoinSchema,
  type JoinConfidence,
  type JoinRequestStatus,
} from "./department-join.js";
import type { DepartmentJoinRequestRecord } from "./department-join-repository.js";
import type { DialogueService } from "./dialogue-service.js";

export interface DepartmentJoinResult {
  requestId: string;
  conversationId: string;
  requesterDepartmentId: string;
  targetDepartmentId: string;
  targetSlug: string;
  justification: string;
  status: JoinRequestStatus;
  decisionRationale: string | null;
  confidence: JoinConfidence | null;
  taskBrief: string | null;
  modelMetadata: Record<string, unknown> | null;
  failureReason: string | null;
  inferenceRequestId: string | null;
  inviteTurnId: string | null;
  idempotentReplay: boolean;
}

type Route = Pick<
  InferenceRoute,
  | "alias"
  | "temperature"
  | "maxOutputTokens"
  | "timeoutMs"
  | "dedicatedRouting"
  | "rates"
  | "globalConcurrency"
  | "departmentConcurrency"
>;

interface JoinCharge {
  requestId: string;
  objectiveId: string | null;
  departmentId: string;
  reservedOutputTokens: number;
  alreadyCompleted: boolean;
}

const JOIN_LEASE_OWNER = "department-join";
const JOIN_LEASE_MS = 60_000;
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

function isBudgetDenial(error: unknown): boolean {
  return error instanceof DomainError && (error.code === "BUDGET_EXCEEDED" || error.details?.budgetDenial === true);
}

export class DepartmentJoinService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly dialogue: DialogueService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestJoin(
    ctx: RequestContext,
    provider: InferenceProvider,
    route: Route,
    conversationId: string,
    input: { targetDepartmentId: string; justification: string; idempotencyKey: string },
  ): Promise<DepartmentJoinResult> {
    this.authorizer.assert(ctx.actor, "message:publish");
    this.requireAgent(ctx);
    this.requireKey(input.idempotencyKey);

    const existing = await this.persistence.repos.departmentJoinRequests.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return this.enrichSlug(this.toResult(existing, true, null));
    }

    const justification = input.justification.trim();
    if (!justification || justification.length > 2_000) {
      throw new DomainError("VALIDATION_ERROR", "Join justification must be between 1 and 2000 characters", 422);
    }

    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      throw notFound("Conversation", conversationId);
    }
    if (conversation.status !== "open") {
      throw new DomainError("INVALID_STATE", "The conversation is closed", 409);
    }

    const participants = await this.persistence.repos.autonomy.listParticipants(conversationId);
    if (!ctx.actor.departmentId || !participants.includes(ctx.actor.departmentId)) {
      throw new DomainError("AUTHORIZATION_DENIED", "Only active conversation participants may request a join", 403);
    }

    const target = await this.requireAvailable(input.targetDepartmentId);
    if (target.id === ctx.actor.departmentId) {
      throw new DomainError("VALIDATION_ERROR", "A department cannot request to join itself", 422);
    }

    const membership = await this.persistence.repos.autonomy.listMembership(conversationId);
    const existingMembership = membership.find((item) => item.departmentId === target.id);
    if (existingMembership?.membership === "active" || existingMembership?.membership === "invited") {
      throw new DomainError("CONFLICT", "The target department is already a conversation member", 409, {
        membership: existingMembership.membership,
        targetDepartmentId: target.id,
      });
    }

    const settings = await this.persistence.repos.autonomy.settings();
    const seated = membership.filter((item) => item.membership === "active" || item.membership === "invited").length;
    if (seated >= settings.maxConversationParticipants) {
      throw new DomainError("BUDGET_EXCEEDED", "The participant limit is already in use", 409, {
        budgetDenial: true,
        limit: "max_conversation_participants",
      });
    }

    const objectiveId = conversation.objectiveId;
    const available = await this.listActiveDepartments();
    const orchestration = available.find((row) => row.slug === "orchestration");
    if (!orchestration) {
      throw new DomainError("INVALID_STATE", "Orchestration department is not active", 409);
    }

    let decision: {
      approve: boolean;
      rationale: string;
      confidence: JoinConfidence;
      metadata: Record<string, unknown>;
      inferenceRequestId: string;
    } | null = null;
    let failureReason: string | null = null;

    try {
      decision = await this.invokeOrchestration(provider, route, {
        conversation,
        requesterDepartmentId: ctx.actor.departmentId,
        target,
        justification,
        participants: membership
          .filter((item) => item.membership === "active")
          .map((item) => item.departmentId),
        available,
        objectiveId,
        idempotencyKey: input.idempotencyKey,
        settings,
        orchestrationId: orchestration.id,
      });
    } catch (error) {
      if (isBudgetDenial(error)) {
        throw error;
      }
      if (error instanceof DomainError && (error.code === "AUTHORIZATION_DENIED" || error.statusCode === 403)) {
        throw error;
      }
      failureReason = (error instanceof Error ? error.message : "orchestration join approval failed").slice(0, 500);
      if (error instanceof InferenceError && route.dedicatedRouting?.enabled) {
        failureReason = `${failureReason} (dedicated routing enabled; shared inference was not used)`;
      }
    }

    // Heuristic fallback is never an AI approval. Model failure => failed status.
    if (!decision) {
      const failed = await this.persistRequest(ctx, {
        idempotencyKey: input.idempotencyKey,
        conversationId,
        requesterDepartmentId: ctx.actor.departmentId,
        targetDepartmentId: target.id,
        justification,
        status: "failed",
        decisionRationale: null,
        confidence: null,
        taskBrief: null,
        inferenceRequestId: null,
        modelMetadata: null,
        failureReason: failureReason ?? "orchestration join approval failed",
      });
      await this.audit(ctx, failed, "failed");
      return this.enrichSlug(this.toResult(failed, false, null));
    }

    if (!decision.approve) {
      const rejected = await this.persistRequest(ctx, {
        idempotencyKey: input.idempotencyKey,
        conversationId,
        requesterDepartmentId: ctx.actor.departmentId,
        targetDepartmentId: target.id,
        justification,
        status: "rejected",
        decisionRationale: decision.rationale,
        confidence: decision.confidence,
        taskBrief: null,
        inferenceRequestId: decision.inferenceRequestId,
        modelMetadata: decision.metadata,
        failureReason: null,
      });
      await this.audit(ctx, rejected, "rejected");
      return this.enrichSlug(this.toResult(rejected, false, null));
    }

    const taskBrief = buildJoinTaskBrief({
      targetSlug: target.slug,
      justification,
      rationale: decision.rationale,
    });
    // Seat through the existing invitation path without a speaker turn (turn-taking would block the opener).
    // Task context lives on the join request (and membership event reason), not as reusable colony knowledge.
    await this.dialogue.seatInvitee(ctx, conversationId, target.id, taskBrief);

    const approved = await this.persistRequest(ctx, {
      idempotencyKey: input.idempotencyKey,
      conversationId,
      requesterDepartmentId: ctx.actor.departmentId,
      targetDepartmentId: target.id,
      justification,
      status: "approved",
      decisionRationale: decision.rationale,
      confidence: decision.confidence,
      taskBrief,
      inferenceRequestId: decision.inferenceRequestId,
      modelMetadata: decision.metadata,
      failureReason: null,
    });
    await this.audit(ctx, approved, "approved");
    return this.enrichSlug(this.toResult(approved, false, null));
  }

  async getJoinRequest(ctx: RequestContext, id: string): Promise<DepartmentJoinResult> {
    this.authorizer.assertAny(ctx.actor, ["message:publish", "audit:read", "autonomy:manage"]);
    const row = await this.persistence.repos.departmentJoinRequests.findById(id);
    if (!row) {
      throw notFound("DepartmentJoinRequest", id);
    }
    if (ctx.actor.role !== "system_administrator" && ctx.actor.role !== "ceo_agent") {
      const participants = await this.persistence.repos.autonomy.listParticipants(row.conversationId);
      if (!ctx.actor.departmentId || !participants.includes(ctx.actor.departmentId)) {
        throw new DomainError("AUTHORIZATION_DENIED", "Join requests are visible to conversation participants only", 403);
      }
    }
    return this.enrichSlug(this.toResult(row, false, null));
  }

  async listJoinRequests(ctx: RequestContext, conversationId: string): Promise<DepartmentJoinResult[]> {
    this.authorizer.assert(ctx.actor, "message:publish");
    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      throw notFound("Conversation", conversationId);
    }
    const membership = await this.persistence.repos.autonomy.listMembership(conversationId);
    const mine = membership.find((item) => item.departmentId === ctx.actor.departmentId);
    if (
      ctx.actor.role !== "system_administrator" &&
      ctx.actor.role !== "ceo_agent" &&
      (!mine || (mine.membership !== "active" && mine.membership !== "invited"))
    ) {
      throw new DomainError("AUTHORIZATION_DENIED", "Join requests are visible to conversation participants only", 403);
    }
    const rows = await this.persistence.repos.departmentJoinRequests.listByConversation(conversationId, 50);
    return Promise.all(rows.map((row) => this.enrichSlug(this.toResult(row, false, null))));
  }

  private async invokeOrchestration(
    provider: InferenceProvider,
    route: Route,
    input: {
      conversation: { id: string; topic: string; objectiveId: string | null };
      requesterDepartmentId: string;
      target: { id: string; slug: string; name: string };
      justification: string;
      participants: string[];
      available: Array<{ id: string; slug: string; name: string; status: string }>;
      objectiveId: string | null;
      idempotencyKey: string;
      settings: Awaited<ReturnType<Persistence["repos"]["autonomy"]["settings"]>>;
      orchestrationId: string;
    },
  ): Promise<{
    approve: boolean;
    rationale: string;
    confidence: JoinConfidence;
    metadata: Record<string, unknown>;
    inferenceRequestId: string;
  }> {
    const selected = selectConversationInference({
      departmentId: input.orchestrationId,
      departmentSlug: "orchestration",
      shared: provider,
      route,
    });
    if (route.dedicatedRouting?.enabled) {
      if (!selected.endpoint || selected.provider === provider) {
        throw new InferenceError(
          "unavailable",
          "Dedicated Orchestration join approval refused shared inference",
          true,
        );
      }
    }

    const maxOutputTokens = Math.min(route.maxOutputTokens, 400);
    const participantSlugs = input.available
      .filter((row) => input.participants.includes(row.id))
      .map((row) => row.slug)
      .sort();
    const messages = [
      {
        role: "system" as const,
        content: `You are the Orchestration department. Decide whether another department may join an ongoing conversation. ${ORCHESTRATION_JOIN_SCHEMA}`,
      },
      {
        role: "user" as const,
        content: [
          `Conversation topic: ${input.conversation.topic}`,
          `Active participants: ${participantSlugs.join(", ") || "(none)"}`,
          `Requested target department: ${input.target.slug}`,
          `Requester justification: ${input.justification}`,
          "Return one JSON object.",
        ].join("\n"),
      },
    ];
    const estimatedTokens = estimateTokens(messages.map((item) => item.content).join("\n")) + maxOutputTokens;

    const existingCharge = await this.persistence.repos.objectives.getInference(`join:${input.idempotencyKey}`);
    const reclaimingHeldSlot = this.isReclaimableJoinCharge(existingCharge);
    if (!reclaimingHeldSlot) {
      this.assertJoinBudget(route, input.settings, input.objectiveId);
      await this.assertBudgetRoom(input.objectiveId, input.settings, maxOutputTokens, estimatedTokens);
    } else if (input.settings.maxInferenceRequests < 1) {
      throw new DomainError("BUDGET_EXCEEDED", "The colony inference budget is exhausted", 409, {
        budgetDenial: true,
        limit: "colony_max_inference_requests",
      });
    }

    const charge = await this.beginJoinCharge({
      objectiveId: input.objectiveId,
      departmentId: input.orchestrationId,
      idempotencyKey: input.idempotencyKey,
      reservedOutputTokens: maxOutputTokens,
      estimatedTokens,
      alias: route.alias,
    });

    const started = this.now();
    let result: InferenceResult | null = null;
    try {
      result = await selected.provider.generate({
        requestId: charge.requestId,
        registryModelId: QWEN3_8B_MODEL_ID,
        modelAlias: route.alias,
        messages,
        temperature: Math.min(route.temperature, 0.2),
        maxOutputTokens,
        timeoutMs: route.timeoutMs,
        jsonObject: true,
      });
      const latencyMs = Math.max(0, this.now().getTime() - started.getTime());
      const usage = result.usage;
      const cost = estimateCostUsdMicros(usage, route.rates ?? { inputUsdPerMillion: null, outputUsdPerMillion: null });

      let extracted: unknown;
      try {
        extracted = extractJsonObject(result.text);
      } catch (error) {
        if (!charge.alreadyCompleted) {
          await this.settleJoinCharge({
            charge,
            status: "failed",
            responseText: result.text,
            error: error instanceof Error ? error.message : "Orchestration join output was not valid JSON",
            usage,
            servedModel: result.servedModel,
            latencyMs,
            rates: route.rates,
            consumeKnownUsage: true,
          });
        }
        throw new DomainError(
          "VALIDATION_ERROR",
          error instanceof Error ? error.message : "Orchestration join output was not valid JSON",
          422,
        );
      }
      const parsed = orchestrationJoinSchema.safeParse(extracted);
      if (!parsed.success) {
        if (!charge.alreadyCompleted) {
          await this.settleJoinCharge({
            charge,
            status: "failed",
            responseText: result.text,
            error: "Orchestration join output failed schema validation",
            usage,
            servedModel: result.servedModel,
            latencyMs,
            rates: route.rates,
            consumeKnownUsage: true,
          });
        }
        throw new DomainError("VALIDATION_ERROR", "Orchestration join output failed schema validation", 422, {
          issues: parsed.error.issues.slice(0, 6),
        });
      }

      if (!charge.alreadyCompleted) {
        await this.settleJoinCharge({
          charge,
          status: "completed",
          responseText: result.text,
          error: null,
          usage,
          servedModel: result.servedModel,
          latencyMs,
          rates: route.rates,
          consumeKnownUsage: true,
        });
      }

      return {
        ...parsed.data,
        inferenceRequestId: charge.requestId,
        metadata: {
          departmentSlug: "orchestration",
          departmentId: input.orchestrationId,
          endpoint: selected.endpoint ?? "shared",
          model: selected.model,
          latencyMs,
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          tokenSource: usage.source,
          servedModel: result.servedModel,
          dedicated: Boolean(route.dedicatedRouting?.enabled),
          budgetCharged: true,
          budgetScope: charge.objectiveId ? "objective" : "colony",
          inferenceRequestId: charge.requestId,
          estimatedCostUsdMicros: cost,
          purpose: "join_approval",
        },
      };
    } catch (error) {
      if (!charge.alreadyCompleted && result === null) {
        await this.settleJoinCharge({
          charge,
          status: "failed",
          responseText: null,
          error: error instanceof Error ? error.message : "orchestration join approval failed",
          usage: { inputTokens: null, outputTokens: null, source: "unavailable" },
          servedModel: selected.model,
          latencyMs: Math.max(0, this.now().getTime() - started.getTime()),
          rates: route.rates,
          consumeKnownUsage: false,
        });
      }
      throw error;
    }
  }

  private isReclaimableJoinCharge(
    existing: Awaited<ReturnType<Persistence["repos"]["objectives"]["getInference"]>>,
  ): boolean {
    if (!existing) {
      return false;
    }
    if (existing.status === "completed") {
      return true;
    }
    if (existing.status !== "running") {
      return false;
    }
    const leaseValid = existing.leaseUntil !== null && Date.parse(existing.leaseUntil) > this.now().getTime();
    return !leaseValid;
  }

  private assertJoinBudget(
    route: Route,
    settings: Awaited<ReturnType<Persistence["repos"]["autonomy"]["settings"]>>,
    objectiveId: string | null,
  ): void {
    if (settings.maxInferenceRequests < 1) {
      throw new DomainError("BUDGET_EXCEEDED", "The colony inference budget is exhausted", 409, {
        budgetDenial: true,
        limit: "colony_max_inference_requests",
      });
    }
    if (
      !objectiveId &&
      settings.consumedInferenceRequests + settings.reservedInferenceRequests >= settings.maxInferenceRequests
    ) {
      throw new DomainError("BUDGET_EXCEEDED", "The colony inference budget is exhausted", 409, {
        budgetDenial: true,
        limit: "colony_max_inference_requests",
        scope: "colony",
      });
    }
    if (route.globalConcurrency < 1) {
      throw new DomainError("BUDGET_EXCEEDED", "The global inference concurrency budget is exhausted", 409, {
        budgetDenial: true,
        limit: "global_concurrency",
      });
    }
    if (route.departmentConcurrency < 1) {
      throw new DomainError("BUDGET_EXCEEDED", "The Orchestration department concurrency budget is exhausted", 409, {
        budgetDenial: true,
        limit: "department_concurrency",
        departmentSlug: "orchestration",
      });
    }
  }

  private async assertBudgetRoom(
    objectiveId: string | null,
    settings: Awaited<ReturnType<Persistence["repos"]["autonomy"]["settings"]>>,
    outputTokens: number,
    estimatedTokens: number,
  ): Promise<void> {
    if (!objectiveId) {
      const requestRoom =
        settings.consumedInferenceRequests + settings.reservedInferenceRequests < settings.maxInferenceRequests;
      const outputRoom =
        settings.consumedOutputTokens +
          settings.estimatedOutputTokens +
          settings.reservedOutputTokens +
          outputTokens <=
        settings.maxInferenceOutputTokens;
      const estimatedRoom =
        settings.estimatedInputTokens + settings.estimatedOutputTokens + estimatedTokens <=
        settings.maxInferenceEstimatedTokens;
      if (!requestRoom || !outputRoom || !estimatedRoom) {
        throw new DomainError("BUDGET_EXCEEDED", "Colony inference budget is exhausted", 409, {
          budgetDenial: true,
          limit: !requestRoom
            ? "max_inference_requests"
            : !outputRoom
              ? "max_inference_output_tokens"
              : "max_inference_estimated_tokens",
          scope: "colony",
        });
      }
      return;
    }
    const run = await this.persistence.repos.objectives.getRun(objectiveId);
    if (!run) {
      throw new DomainError("INVALID_REFERENCE", "Referenced objective does not exist", 422);
    }
    const requestRoom = run.consumedRequests + run.reservedRequests < run.limits.maxInferenceRequests;
    const outputRoom =
      run.consumedOutputTokens + run.estimatedOutputTokens + run.reservedOutputTokens + outputTokens <=
      run.limits.maxOutputTokens;
    const estimatedRoom =
      run.estimatedInputTokens + run.estimatedOutputTokens + estimatedTokens <= run.limits.maxEstimatedTokens;
    if (!requestRoom || !outputRoom || !estimatedRoom) {
      throw new DomainError("BUDGET_EXCEEDED", "Objective inference budget is exhausted", 409, {
        budgetDenial: true,
        limit: !requestRoom ? "max_inference_requests" : !outputRoom ? "max_output_tokens" : "max_estimated_tokens",
        objectiveId,
        scope: "objective",
      });
    }
  }

  private async beginJoinCharge(input: {
    objectiveId: string | null;
    departmentId: string;
    idempotencyKey: string;
    reservedOutputTokens: number;
    estimatedTokens: number;
    alias: string;
  }): Promise<JoinCharge> {
    const key = `join:${input.idempotencyKey}`;
    const leaseUntil = new Date(this.now().getTime() + JOIN_LEASE_MS);
    const existing = await this.persistence.repos.objectives.getInference(key);
    if (existing?.status === "completed") {
      return {
        requestId: existing.id,
        objectiveId: input.objectiveId,
        departmentId: input.departmentId,
        reservedOutputTokens: existing.reservedOutputTokens,
        alreadyCompleted: true,
      };
    }
    if (existing?.status === "running") {
      const leaseValid = existing.leaseUntil !== null && Date.parse(existing.leaseUntil) > this.now().getTime();
      if (leaseValid) {
        throw new DomainError("CONFLICT", "A join approval inference request is already in progress for this key", 409, {
          idempotencyKey: input.idempotencyKey,
        });
      }
      await this.persistence.repos.objectives.reopenInference(existing.id, JOIN_LEASE_OWNER, leaseUntil);
      return {
        requestId: existing.id,
        objectiveId: input.objectiveId,
        departmentId: input.departmentId,
        reservedOutputTokens: existing.reservedOutputTokens,
        alreadyCompleted: false,
      };
    }

    const reservedOk = await this.persistence.repos.objectives.reserve({
      objectiveId: input.objectiveId,
      outputTokens: input.reservedOutputTokens,
      estimatedTokens: input.estimatedTokens,
    });
    if (!reservedOk) {
      throw new DomainError(
        "BUDGET_EXCEEDED",
        input.objectiveId ? "Objective inference budget is exhausted" : "Colony inference budget is exhausted",
        409,
        {
          budgetDenial: true,
          limit: "reserve",
          objectiveId: input.objectiveId,
          scope: input.objectiveId ? "objective" : "colony",
        },
      );
    }

    if (existing?.status === "failed") {
      await this.persistence.repos.objectives.reopenInference(existing.id, JOIN_LEASE_OWNER, leaseUntil);
      return {
        requestId: existing.id,
        objectiveId: input.objectiveId,
        departmentId: input.departmentId,
        reservedOutputTokens: existing.reservedOutputTokens,
        alreadyCompleted: false,
      };
    }

    const id = randomUUID();
    const created = await this.persistence.repos.objectives.insertInference({
      id,
      objectiveId: input.objectiveId,
      departmentId: input.departmentId,
      taskId: null,
      attempt: 1,
      purpose: "join_approval",
      registryModelId: QWEN3_8B_MODEL_ID,
      intendedModelId: QWEN3_8B_MODEL_ID,
      requestedAlias: input.alias,
      reservedOutputTokens: input.reservedOutputTokens,
      idempotencyKey: key,
      leaseOwner: JOIN_LEASE_OWNER,
      leaseUntil,
    });
    if (created === "exists") {
      await this.persistence.repos.objectives.releaseReservation(input.objectiveId, input.reservedOutputTokens);
      const winner = await this.persistence.repos.objectives.getInference(key);
      if (winner?.status === "completed") {
        return {
          requestId: winner.id,
          objectiveId: input.objectiveId,
          departmentId: input.departmentId,
          reservedOutputTokens: winner.reservedOutputTokens,
          alreadyCompleted: true,
        };
      }
      throw new DomainError("CONFLICT", "A concurrent join approval already claimed this budget key", 409, {
        idempotencyKey: input.idempotencyKey,
      });
    }
    return {
      requestId: id,
      objectiveId: input.objectiveId,
      departmentId: input.departmentId,
      reservedOutputTokens: input.reservedOutputTokens,
      alreadyCompleted: false,
    };
  }

  private async settleJoinCharge(input: {
    charge: JoinCharge;
    status: "completed" | "failed";
    responseText: string | null;
    error: string | null;
    usage: TokenUsage;
    servedModel: string;
    latencyMs: number;
    rates: CostRates | undefined;
    consumeKnownUsage: boolean;
  }): Promise<void> {
    const { charge } = input;
    await this.persistence.repos.objectives.finishInference(charge.requestId, {
      status: input.status,
      responseText: input.responseText,
      error: input.error ? input.error.slice(0, 500) : null,
    });
    if (!input.consumeKnownUsage) {
      await this.persistence.repos.objectives.releaseReservation(charge.objectiveId, charge.reservedOutputTokens);
      return;
    }
    const cost = estimateCostUsdMicros(
      input.usage,
      input.rates ?? { inputUsdPerMillion: null, outputUsdPerMillion: null },
    );
    const estimatedOut = input.usage.outputTokens === null && input.responseText ? estimateTokens(input.responseText) : 0;
    try {
      await this.persistence.repos.objectives.insertUsage({
        requestId: charge.requestId,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        tokenSource: input.usage.source,
        servedModel: input.servedModel.slice(0, 200),
        latencyMs: input.latencyMs,
        estimatedCostUsdMicros: cost,
        overrideApplied: false,
      });
    } catch {
      // Idempotent settle.
    }
    await this.persistence.repos.objectives.reconcile({
      objectiveId: charge.objectiveId,
      reservedOutputTokens: charge.reservedOutputTokens,
      observedInputTokens: input.usage.inputTokens ?? 0,
      observedOutputTokens: input.usage.outputTokens ?? 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: estimatedOut,
      estimatedCostUsdMicros: cost,
    });
  }

  private async persistRequest(
    ctx: RequestContext,
    input: {
      idempotencyKey: string;
      conversationId: string;
      requesterDepartmentId: string;
      targetDepartmentId: string;
      justification: string;
      status: JoinRequestStatus;
      decisionRationale: string | null;
      confidence: JoinConfidence | null;
      taskBrief: string | null;
      inferenceRequestId: string | null;
      modelMetadata: Record<string, unknown> | null;
      failureReason: string | null;
    },
  ): Promise<DepartmentJoinRequestRecord> {
    const record: DepartmentJoinRequestRecord = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      conversationId: input.conversationId,
      requesterDepartmentId: input.requesterDepartmentId,
      targetDepartmentId: input.targetDepartmentId,
      justification: input.justification,
      status: input.status,
      decisionRationale: input.decisionRationale,
      confidence: input.confidence,
      taskBrief: input.taskBrief,
      inferenceRequestId: input.inferenceRequestId,
      modelMetadata: input.modelMetadata,
      failureReason: input.failureReason,
      createdBy: ctx.actor.principalId,
      correlationId: ctx.correlationId,
      createdAt: this.now().toISOString(),
      decidedAt: this.now().toISOString(),
    };
    try {
      return await this.persistence.repos.departmentJoinRequests.insert(record);
    } catch (error) {
      if (error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT") {
        const winner = await this.persistence.repos.departmentJoinRequests.findByIdempotencyKey(input.idempotencyKey);
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  private async audit(
    ctx: RequestContext,
    row: DepartmentJoinRequestRecord,
    outcome: "approved" | "rejected" | "failed",
  ): Promise<void> {
    await this.persistence.repos.audit.append({
      eventType: `conversation.join_request.${outcome}`,
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "department_join_request",
      targetId: row.id,
      action: outcome,
      correlationId: ctx.correlationId,
      beforeState: null,
      afterState: {
        status: row.status,
        conversationId: row.conversationId,
        requesterDepartmentId: row.requesterDepartmentId,
        targetDepartmentId: row.targetDepartmentId,
        inferenceRequestId: row.inferenceRequestId,
      },
      metadata: {
        confidence: row.confidence,
        failureReason: row.failureReason,
        modelMetadata: row.modelMetadata,
      },
    });
  }

  private async listActiveDepartments(): Promise<Array<{ id: string; slug: string; name: string; status: string }>> {
    const page = await this.persistence.repos.departments.list({ limit: 100, cursor: null });
    return page.data
      .filter((row) => row.status === "active")
      .map((row) => ({ id: row.id, slug: row.slug, name: row.name, status: row.status }));
  }

  private async requireAvailable(departmentId: string): Promise<{ id: string; slug: string; name: string; status: string }> {
    const department = await this.persistence.repos.autonomy.department(departmentId);
    if (!department || department.status !== "active") {
      throw new DomainError("INVALID_REFERENCE", "Target department is not an active join candidate", 422, {
        departmentId,
      });
    }
    const agent = await this.persistence.repos.autonomy.departmentAgent(departmentId);
    if (!agent || !["idle", "running", "paused"].includes(agent.status)) {
      throw new DomainError("INVALID_STATE", "Target department has no available agent", 409, { departmentId });
    }
    return department;
  }

  private toResult(
    row: DepartmentJoinRequestRecord,
    idempotentReplay: boolean,
    inviteTurnId: string | null,
  ): DepartmentJoinResult {
    const metaInvite =
      row.modelMetadata && typeof row.modelMetadata.inviteTurnId === "string" ? row.modelMetadata.inviteTurnId : null;
    return {
      requestId: row.id,
      conversationId: row.conversationId,
      requesterDepartmentId: row.requesterDepartmentId,
      targetDepartmentId: row.targetDepartmentId,
      targetSlug: "",
      justification: row.justification,
      status: row.status,
      decisionRationale: row.decisionRationale,
      confidence: row.confidence,
      taskBrief: row.taskBrief,
      modelMetadata: row.modelMetadata,
      failureReason: row.failureReason,
      inferenceRequestId: row.inferenceRequestId,
      inviteTurnId: inviteTurnId ?? metaInvite,
      idempotentReplay,
    };
  }

  private async enrichSlug(result: DepartmentJoinResult): Promise<DepartmentJoinResult> {
    const department = await this.persistence.repos.autonomy.department(result.targetDepartmentId);
    return { ...result, targetSlug: department?.slug ?? "" };
  }

  private requireAgent(ctx: RequestContext): void {
    if (ctx.actor.principalType !== "agent" || !ctx.actor.departmentId || !ctx.actor.agentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Only department agents may request joins", 403);
    }
  }

  private requireKey(key: string): void {
    if (!KEY.test(key)) {
      throw new DomainError("VALIDATION_ERROR", "Invalid idempotency key", 422);
    }
  }
}
