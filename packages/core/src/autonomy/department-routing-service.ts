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
  ORCHESTRATION_ROUTE_SCHEMA,
  boundedFallbackDepartments,
  orchestrationRouteSchema,
  tryDeterministicDepartmentRoute,
  validateRoutedDepartments,
  type AvailableDepartment,
  type RoutingConfidence,
  type RoutingMethod,
} from "./department-routing.js";
import type { DepartmentRoutingDecisionRecord } from "./department-routing-repository.js";

export interface DepartmentRoutingResult {
  decisionId: string;
  method: RoutingMethod;
  primaryDepartmentId: string;
  primarySlug: string;
  additionalDepartmentIds: string[];
  additionalSlugs: string[];
  finalParticipantIds: string[];
  rejectedRecommendations: Array<Record<string, unknown>>;
  rationale: string;
  confidence: RoutingConfidence;
  uncertainty: string | null;
  approvalRequired: boolean;
  modelMetadata: Record<string, unknown> | null;
  fallbackReason: string | null;
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

interface RoutingCharge {
  requestId: string;
  objectiveId: string | null;
  departmentId: string;
  reservedOutputTokens: number;
  alreadyCompleted: boolean;
}

const ROUTING_LEASE_OWNER = "department-routing";
const ROUTING_LEASE_MS = 60_000;

function isBudgetDenial(error: unknown): boolean {
  return error instanceof DomainError && (error.code === "BUDGET_EXCEEDED" || error.details?.budgetDenial === true);
}

export class DepartmentRoutingService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async route(
    ctx: RequestContext,
    provider: InferenceProvider,
    route: Route,
    input: {
      task: string;
      objectiveId?: string | null;
      idempotencyKey: string;
      maxParticipants?: number;
      excludeDepartmentId?: string | null;
    },
  ): Promise<DepartmentRoutingResult> {
    this.authorizer.assert(ctx.actor, "message:publish");
    this.requireKey(input.idempotencyKey);
    const existing = await this.persistence.repos.departmentRouting.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      const available = await this.listAvailable();
      return this.toResult(existing, new Map(available.map((row) => [row.id, row])), true);
    }

    const task = input.task.trim();
    if (!task || task.length > 2_000) {
      throw new DomainError("VALIDATION_ERROR", "Routing task must be between 1 and 2000 characters", 422);
    }
    if (input.objectiveId) {
      const run = await this.persistence.repos.objectives.getRun(input.objectiveId);
      if (!run) {
        throw new DomainError("INVALID_REFERENCE", "Referenced objective does not exist", 422);
      }
    }

    const settings = await this.persistence.repos.autonomy.settings();
    const maxParticipants = Math.min(
      Math.max(input.maxParticipants ?? settings.maxConversationParticipants, 2),
      settings.maxConversationParticipants,
    );
    const available = await this.listAvailable();
    if (available.filter((row) => row.status === "active").length < 1) {
      throw new DomainError("INVALID_STATE", "No active departments are available for routing", 409);
    }

    const byId = new Map(available.map((row) => [row.id, row]));
    const excludeDepartmentId = input.excludeDepartmentId ?? ctx.actor.departmentId;
    const deterministic = tryDeterministicDepartmentRoute(task);
    if (deterministic) {
      const validated = validateRoutedDepartments({
        primarySlug: deterministic.primarySlug,
        additionalSlugs: deterministic.additionalSlugs,
        available,
        maxParticipants,
        excludeDepartmentId,
      });
      return this.persistDecision(ctx, byId, {
        idempotencyKey: input.idempotencyKey,
        taskText: task,
        objectiveId: input.objectiveId ?? null,
        method: "deterministic",
        primary: validated.primary,
        additional: validated.additional,
        rejected: validated.rejected,
        finalIds: validated.finalIds,
        rationale: deterministic.rationale,
        confidence: deterministic.confidence,
        uncertainty: null,
        approvalRequired: false,
        modelMetadata: null,
        fallbackReason: null,
      });
    }

    let modeled: Awaited<ReturnType<DepartmentRoutingService["invokeOrchestration"]>> | null = null;
    let orchestrationError: string | null = null;
    try {
      modeled = await this.invokeOrchestration(provider, route, task, available, {
        objectiveId: input.objectiveId ?? null,
        idempotencyKey: input.idempotencyKey,
        settings,
      });
    } catch (error) {
      // Budget denials and auth must not become silent fallback seating.
      if (isBudgetDenial(error)) {
        throw error;
      }
      if (error instanceof DomainError && (error.code === "AUTHORIZATION_DENIED" || error.statusCode === 403)) {
        throw error;
      }
      orchestrationError = error instanceof Error ? error.message : "orchestration routing failed";
      if (error instanceof InferenceError && route.dedicatedRouting?.enabled) {
        orchestrationError = `${error.message} (dedicated routing enabled; shared inference was not used)`;
      }
    }

    if (modeled) {
      const validated = validateRoutedDepartments({
        primarySlug: modeled.primarySlug,
        additionalSlugs: modeled.additionalSlugs,
        available,
        maxParticipants,
        excludeDepartmentId,
      });
      return this.persistDecision(ctx, byId, {
        idempotencyKey: input.idempotencyKey,
        taskText: task,
        objectiveId: input.objectiveId ?? null,
        method: "model_assisted",
        primary: validated.primary,
        additional: validated.additional,
        rejected: validated.rejected,
        finalIds: validated.finalIds,
        rationale: modeled.rationale,
        confidence: modeled.confidence,
        uncertainty: modeled.confidence === "low" ? "Orchestration reported low confidence" : null,
        approvalRequired: modeled.approvalRequired || modeled.confidence === "low",
        modelMetadata: modeled.metadata,
        fallbackReason: null,
      });
    }

    const fallback = boundedFallbackDepartments(task, available);
    const validated = validateRoutedDepartments({
      primarySlug: fallback.primarySlug,
      additionalSlugs: fallback.additionalSlugs,
      available,
      maxParticipants,
      excludeDepartmentId,
    });
    return this.persistDecision(ctx, byId, {
      idempotencyKey: input.idempotencyKey,
      taskText: task,
      objectiveId: input.objectiveId ?? null,
      method: "fallback",
      primary: validated.primary,
      additional: validated.additional,
      rejected: validated.rejected,
      finalIds: validated.finalIds,
      rationale: fallback.rationale,
      confidence: "low",
      uncertainty: "Orchestration inference failed; bounded fallback applied",
      approvalRequired: true,
      modelMetadata: null,
      fallbackReason: (orchestrationError ?? "orchestration routing failed").slice(0, 500),
    });
  }

  async getDecision(ctx: RequestContext, id: string): Promise<DepartmentRoutingResult> {
    this.authorizer.assertAny(ctx.actor, ["message:publish", "audit:read", "autonomy:manage"]);
    const row = await this.persistence.repos.departmentRouting.findById(id);
    if (!row) {
      throw notFound("DepartmentRoutingDecision", id);
    }
    const available = await this.listAvailable();
    return this.toResult(row, new Map(available.map((item) => [item.id, item])), false);
  }

  private async invokeOrchestration(
    provider: InferenceProvider,
    route: Route,
    task: string,
    available: AvailableDepartment[],
    accounting: {
      objectiveId: string | null;
      idempotencyKey: string;
      settings: Awaited<ReturnType<Persistence["repos"]["autonomy"]["settings"]>>;
    },
  ): Promise<{
    primarySlug: string;
    additionalSlugs: string[];
    rationale: string;
    confidence: RoutingConfidence;
    approvalRequired: boolean;
    metadata: Record<string, unknown>;
  }> {
    const orchestration = available.find((row) => row.slug === "orchestration" && row.status === "active");
    if (!orchestration) {
      throw new DomainError("INVALID_STATE", "Orchestration department is not active", 409);
    }

    const selected = selectConversationInference({
      departmentId: orchestration.id,
      departmentSlug: orchestration.slug,
      shared: provider,
      route,
    });
    if (route.dedicatedRouting?.enabled) {
      // Fail closed: never execute Orchestration routing on the shared provider when dedicated is required.
      if (!selected.endpoint || selected.provider === provider) {
        throw new InferenceError(
          "unavailable",
          "Dedicated Orchestration routing refused shared inference",
          true,
        );
      }
    }

    const maxOutputTokens = Math.min(route.maxOutputTokens, 400);
    const slugs = available
      .filter((row) => row.status === "active")
      .map((row) => row.slug)
      .sort();
    const messages = [
      {
        role: "system" as const,
        content: `You are the Orchestration department. Select which AI Colony departments should handle a task. ${ORCHESTRATION_ROUTE_SCHEMA}`,
      },
      {
        role: "user" as const,
        content: [
          `Available active departments: ${slugs.join(", ")}.`,
          `Task: ${task}`,
          "Return one JSON object.",
        ].join("\n"),
      },
    ];
    const estimatedTokens = estimateTokens(messages.map((item) => item.content).join("\n")) + maxOutputTokens;

    // Completed or stale-running charges already hold (or already consumed) their budget slot.
    // Soft gates must not demand a second free slot before beginRoutingCharge can reclaim.
    const existingCharge = await this.persistence.repos.objectives.getInference(
      `routing:${accounting.idempotencyKey}`,
    );
    const reclaimingHeldSlot = this.isReclaimableRoutingCharge(existingCharge);
    if (!reclaimingHeldSlot) {
      this.assertRoutingBudget(route, accounting.settings, accounting.objectiveId);
      await this.assertBudgetRoom(accounting.objectiveId, accounting.settings, maxOutputTokens, estimatedTokens);
    } else {
      // Still refuse when the colony hard-disables inference entirely.
      if (accounting.settings.maxInferenceRequests < 1) {
        throw new DomainError("BUDGET_EXCEEDED", "The colony inference budget is exhausted", 409, {
          budgetDenial: true,
          limit: "colony_max_inference_requests",
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

    const charge = await this.beginRoutingCharge({
      objectiveId: accounting.objectiveId,
      departmentId: orchestration.id,
      idempotencyKey: accounting.idempotencyKey,
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
          await this.settleRoutingCharge({
            charge,
            status: "failed",
            responseText: result.text,
            error: error instanceof Error ? error.message : "Orchestration routing output was not valid JSON",
            usage,
            servedModel: result.servedModel,
            latencyMs,
            rates: route.rates,
            consumeKnownUsage: true,
          });
        }
        throw new DomainError(
          "VALIDATION_ERROR",
          error instanceof Error ? error.message : "Orchestration routing output was not valid JSON",
          422,
        );
      }
      const parsed = orchestrationRouteSchema.safeParse(extracted);
      if (!parsed.success) {
        if (!charge.alreadyCompleted) {
          await this.settleRoutingCharge({
            charge,
            status: "failed",
            responseText: result.text,
            error: "Orchestration routing output failed schema validation",
            usage,
            servedModel: result.servedModel,
            latencyMs,
            rates: route.rates,
            consumeKnownUsage: true,
          });
        }
        throw new DomainError("VALIDATION_ERROR", "Orchestration routing output failed schema validation", 422, {
          issues: parsed.error.issues.slice(0, 6),
        });
      }

      if (!charge.alreadyCompleted) {
        await this.settleRoutingCharge({
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
        additionalSlugs: parsed.data.additionalSlugs.filter((slug) => slug !== parsed.data.primarySlug),
        metadata: {
          departmentSlug: "orchestration",
          departmentId: orchestration.id,
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
        },
      };
    } catch (error) {
      if (!charge.alreadyCompleted && result === null) {
        await this.settleRoutingCharge({
          charge,
          status: "failed",
          responseText: null,
          error: error instanceof Error ? error.message : "orchestration routing failed",
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

  private isReclaimableRoutingCharge(
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

  private assertRoutingBudget(
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

  private async beginRoutingCharge(input: {
    objectiveId: string | null;
    departmentId: string;
    idempotencyKey: string;
    reservedOutputTokens: number;
    estimatedTokens: number;
    alias: string;
  }): Promise<RoutingCharge> {
    const key = `routing:${input.idempotencyKey}`;
    const leaseUntil = new Date(this.now().getTime() + ROUTING_LEASE_MS);
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
        throw new DomainError("CONFLICT", "A routing inference request is already in progress for this key", 409, {
          idempotencyKey: input.idempotencyKey,
        });
      }
      // Stale lease: prior reservation is still held; reclaim without a second reserve.
      await this.persistence.repos.objectives.reopenInference(existing.id, ROUTING_LEASE_OWNER, leaseUntil);
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
      await this.persistence.repos.objectives.reopenInference(existing.id, ROUTING_LEASE_OWNER, leaseUntil);
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
      purpose: "routing",
      registryModelId: QWEN3_8B_MODEL_ID,
      intendedModelId: QWEN3_8B_MODEL_ID,
      requestedAlias: input.alias,
      reservedOutputTokens: input.reservedOutputTokens,
      idempotencyKey: key,
      leaseOwner: ROUTING_LEASE_OWNER,
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
      throw new DomainError("CONFLICT", "A concurrent routing inference already claimed this budget key", 409, {
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

  private async settleRoutingCharge(input: {
    charge: RoutingCharge;
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
    // Only consume when the provider returned (known usage path). Pre-generate failures release the reservation.
    if (!input.consumeKnownUsage) {
      await this.persistence.repos.objectives.releaseReservation(charge.objectiveId, charge.reservedOutputTokens);
      return;
    }
    const cost = estimateCostUsdMicros(
      input.usage,
      input.rates ?? { inputUsdPerMillion: null, outputUsdPerMillion: null },
    );
    const estimatedOut = input.usage.outputTokens === null && input.responseText ? estimateTokens(input.responseText) : 0;
    const estimatedIn = input.usage.inputTokens === null ? 0 : 0;
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
      // Idempotent settle: usage row may already exist from a concurrent twin.
    }
    await this.persistence.repos.objectives.reconcile({
      objectiveId: charge.objectiveId,
      reservedOutputTokens: charge.reservedOutputTokens,
      observedInputTokens: input.usage.inputTokens ?? 0,
      observedOutputTokens: input.usage.outputTokens ?? 0,
      estimatedInputTokens: estimatedIn,
      estimatedOutputTokens: estimatedOut,
      estimatedCostUsdMicros: cost,
    });
  }

  private async listAvailable(): Promise<AvailableDepartment[]> {
    const page = await this.persistence.repos.departments.list({
      limit: 100,
      cursor: null,
    });
    return page.data.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
    }));
  }

  private async persistDecision(
    ctx: RequestContext,
    byId: Map<string, AvailableDepartment>,
    input: {
      idempotencyKey: string;
      taskText: string;
      objectiveId: string | null;
      method: RoutingMethod;
      primary: AvailableDepartment;
      additional: AvailableDepartment[];
      rejected: Array<{ slug: string; reason: string }>;
      finalIds: string[];
      rationale: string;
      confidence: RoutingConfidence;
      uncertainty: string | null;
      approvalRequired: boolean;
      modelMetadata: Record<string, unknown> | null;
      fallbackReason: string | null;
    },
  ): Promise<DepartmentRoutingResult> {
    const record: DepartmentRoutingDecisionRecord = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      taskText: input.taskText,
      objectiveId: input.objectiveId,
      method: input.method,
      primaryDepartmentId: input.primary.id,
      recommendedDepartmentIds: [input.primary.id, ...input.additional.map((row) => row.id)],
      rejectedRecommendations: input.rejected,
      finalParticipantIds: input.finalIds,
      rationale: input.rationale,
      confidence: input.confidence,
      uncertainty: input.uncertainty,
      approvalRequired: input.approvalRequired,
      modelMetadata: input.modelMetadata,
      fallbackReason: input.fallbackReason,
      createdBy: ctx.actor.principalId,
      correlationId: ctx.correlationId,
      createdAt: this.now().toISOString(),
    };
    try {
      const saved = await this.persistence.repos.departmentRouting.insert(record);
      await this.persistence.repos.audit.append({
        eventType: "conversation.routing.decided",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "department_routing_decision",
        targetId: saved.id,
        action: "decided",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: {
          method: saved.method,
          primaryDepartmentId: saved.primaryDepartmentId,
          finalParticipantIds: saved.finalParticipantIds,
          approvalRequired: saved.approvalRequired,
          fallbackReason: saved.fallbackReason,
        },
        metadata: {
          confidence: saved.confidence,
          rejectedCount: saved.rejectedRecommendations.length,
        },
      });
      return this.toResult(saved, byId, false);
    } catch (error) {
      if (error instanceof DomainError && (error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT")) {
        const winner = await this.persistence.repos.departmentRouting.findByIdempotencyKey(input.idempotencyKey);
        if (winner) {
          return this.toResult(winner, byId, true);
        }
      }
      throw error;
    }
  }

  private toResult(
    row: DepartmentRoutingDecisionRecord,
    byId: Map<string, AvailableDepartment>,
    idempotentReplay: boolean,
  ): DepartmentRoutingResult {
    const additionalIds = row.recommendedDepartmentIds.filter((id) => id !== row.primaryDepartmentId);
    return {
      decisionId: row.id,
      method: row.method,
      primaryDepartmentId: row.primaryDepartmentId,
      primarySlug: byId.get(row.primaryDepartmentId)?.slug ?? "unknown",
      additionalDepartmentIds: additionalIds,
      additionalSlugs: additionalIds.map((id) => byId.get(id)?.slug ?? "unknown"),
      finalParticipantIds: row.finalParticipantIds,
      rejectedRecommendations: row.rejectedRecommendations,
      rationale: row.rationale,
      confidence: row.confidence,
      uncertainty: row.uncertainty,
      approvalRequired: row.approvalRequired,
      modelMetadata: row.modelMetadata,
      fallbackReason: row.fallbackReason,
      idempotentReplay,
    };
  }

  private requireKey(key: string): void {
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) {
      throw new DomainError("VALIDATION_ERROR", "Invalid idempotency key", 422);
    }
  }
}
