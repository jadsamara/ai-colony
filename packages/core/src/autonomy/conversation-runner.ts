import { randomUUID } from "node:crypto";
import { QWEN3_8B_MODEL_ID, type DialogueKind } from "@ai-colony/contracts";
import { z } from "zod";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { InferenceProvider, InferenceResult } from "../inference/provider.js";
import { extractJsonObject } from "../objectives/plan.js";
import type { InferenceRoute } from "../objectives/objective-service.js";
import type { Persistence } from "../ports/repositories.js";
import { assessProgress, cleanRecoveryPrompt, departmentContributions, departmentFollowUp, isNearVerbatim, permitsEcho, planRecovery, recoveryInstruction, repetitionCorrection, type InferenceTurnLog } from "./conversation-quality.js";
import { buildCheckpoint, classifyClaim, measureProgress, renderCheckpoint, repetitionVerdict, requestsObjectiveChange, reviewMathClaim, validateContribution } from "./conversation-integrity.js";
import { logConversationInference, selectConversationInference } from "./conversation-routing.js";
import type { DialogueService } from "./dialogue-service.js";
import { redactSensitive } from "./policy.js";
import type { ConversationJob, ConversationRecord } from "./repository.js";
import { buildDialogueContext, maySpeak, orchestrationRecommendation } from "./speakers.js";
import { TrainingEvidenceService } from "../training/evidence-service.js";
import { classifyFailure, type AcceptanceStatus, type FailureClass } from "../training/evidence-taxonomy.js";
import { ClaimVerificationService } from "../verification/claim-verification-service.js";
import {
  deriveDeliverables,
  evaluateConclusionGate,
  preferredSpeakerForDeliverables,
  reconcileDeliverables,
  renderDeliverableChecklist,
} from "../verification/deliverables.js";
import type { ConversationProgress } from "./conversation-quality.js";
import {
  classifyDecisionParseFailure,
  DECISION_KINDS,
  DECISION_RESPONSE_JSON_SCHEMA,
  type DecisionFailureKind,
} from "./structured-decision.js";

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 3;
/** Corrections after the initial generation for invalid model output. */
export const MAX_INVALID_CORRECTIONS = 2;
const UNCERTAIN = /uncertain|cannot verify|not established|unresolved|open question/i;
const decisionSchema = z.object({
  kind: z.enum(DECISION_KINDS),
  body: z.string().trim().min(1).max(4_000),
  addressedSlug: z.string().trim().min(1).max(64).nullable().optional(),
  inviteSlug: z.string().trim().min(1).max(64).nullable().optional(),
  decision: z.enum(["speak", "accept", "decline"]).optional(),
  searchQuery: z.string().trim().min(1).max(200).nullable().optional(),
  workingGroup: z.array(z.string().trim().min(1).max(64)).max(4).optional(),
});

const DIAGNOSTIC_LIMIT = 240;

export const DECISION_JSON_SCHEMA = [
  "Return one JSON object and no other text.",
  `Required JSON schema: {"kind":"${DECISION_KINDS.join("|")}","body":"string"}.`,
  `kind is required. Use exactly one of these enum values and no synonyms: ${DECISION_KINDS.join(", ")}.`,
  "Do not invent kinds such as essay, answer, analysis, statement, comment, or message.",
  "body is required and must be a non-empty research contribution of at most 4000 characters.",
  "Write a backslash inside a JSON string as two backslashes. A single backslash before frac, nabla, theta, text, or times is not valid JSON.",
  "Optional fields: addressedSlug (string or null), inviteSlug (string or null), decision (speak, accept, or decline), searchQuery (string or null), workingGroup (array of at most 4 department slugs).",
  "Do not omit kind or body. Do not invent fields. Do not invent citations.",
].join(" ");

export { DECISION_RESPONSE_JSON_SCHEMA, DECISION_KINDS };
export type { DecisionFailureKind };

export type DecisionDraft = z.infer<typeof decisionSchema>;

export type DecisionInspection =
  | { ok: true; value: DecisionDraft }
  | { ok: false; diagnostic: string; failureKind: DecisionFailureKind };

export function inspectDecision(text: string): DecisionInspection {
  let extracted: unknown;
  try {
    extracted = extractJsonObject(text);
  } catch (error) {
    const classified = classifyDecisionParseFailure(
      text,
      error instanceof Error ? error : new Error("output was not valid JSON"),
    );
    return { ok: false, diagnostic: boundDiagnostic(classified.reason), failureKind: classified.kind };
  }
  const parsed = decisionSchema.safeParse(extracted);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map(formatIssue);
    return {
      ok: false,
      diagnostic: boundDiagnostic(issues.join("; ") || "output did not match the schema"),
      failureKind: "schema_invalid",
    };
  }
  const contribution = validateContribution({ kind: parsed.data.kind, body: parsed.data.body });
  if (!contribution.ok) {
    return {
      ok: false,
      diagnostic: boundDiagnostic(contribution.reason),
      failureKind: "contribution_invalid",
    };
  }
  return { ok: true, value: parsed.data };
}

export function correctionInstruction(_previousOutput: string, diagnostic: string): string {
  return [
    "The previous generation was rejected and was not stored as a transcript turn.",
    `Reason: ${diagnostic}`,
    "Return one new JSON object with kind and body.",
    `kind must be exactly one of: ${DECISION_KINDS.join(", ")}.`,
    "body must be research content only. Do not mention JSON, validation, schemas, retries, or formatting.",
    DECISION_JSON_SCHEMA,
  ].join("\n");
}

export interface ConversationRunResult {
  conversationId: string;
  produced: number;
  stop: string;
  execution: {
    stop: string;
    produced: number;
  };
  research: {
    status: string;
    outcome: string | null;
    closeReason: string | null;
    finalConclusion: string | null;
    unresolvedQuestions: string[];
    substantialProgress: boolean;
    budget: {
      messagesRemaining: number;
      tokensSpent: number;
      maxMessages: number;
      maxTokens: number;
    };
  };
}

function formatIssue(issue: { code: string; path: PropertyKey[]; message: string }): string {
  const path = issue.path.length ? issue.path.map(String).join(".") : "object";
  if (issue.code === "invalid_enum_value" || issue.code === "invalid_value") {
    // Do not echo the received value (may contain secrets). Name the allowed enum for kind.
    if (path === "kind") {
      return `kind: invalid value; allowed: ${DECISION_KINDS.join("|")}`;
    }
    return `${path}: invalid value`;
  }
  return `${path}: ${issue.message.replace(/\s+/g, " ").trim().slice(0, 120)}`;
}

function boundDiagnostic(reason: string): string {
  const prefix = "model_invalid: ";
  const cleaned = redactSensitive(reason).replace(/\s+/g, " ").trim();
  const room = DIAGNOSTIC_LIMIT - prefix.length;
  const body = cleaned.length > room ? `${cleaned.slice(0, Math.max(0, room - 1))}…` : cleaned;
  return `${prefix}${body}`;
}

export interface ConversationWake {
  publish(payload: { jobId: string; conversationId: string; fence: number }): Promise<void>;
}

type ClaimResult =
  | { kind: "job"; job: ConversationJob; token: string; speakerDepartmentId: string }
  | { kind: "deferred" | "backpressure" | "idle" | "in_flight" | "paused" | "disabled" | "closed" | "stopped" };

/**
 * Durable conversation runner.
 *
 * Postgres jobs are the source of truth. A wake publish is best-effort and
 * may be delivered twice. Inference can run again when a worker dies before
 * the turn body is stored. The turn idempotency key `runner:<job id>` keeps
 * one transcript row and one usage charge for that job.
 */
export class ConversationRunner {
  private readonly evidence: TrainingEvidenceService;
  private readonly claims: ClaimVerificationService;

  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly dialogue: DialogueService,
    private readonly now: () => Date = () => new Date(),
    private readonly wake?: ConversationWake,
    private readonly leaseMs = LEASE_MS,
  ) {
    this.evidence = new TrainingEvidenceService(persistence, authorizer, undefined, now);
    this.claims = new ClaimVerificationService(persistence, authorizer, now);
  }

  async run(
    ctx: RequestContext,
    conversationId: string,
    provider: InferenceProvider,
    route: InferenceRoute,
    options?: { maxTurns?: number },
  ): Promise<ConversationRunResult> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const settings = await this.persistence.repos.autonomy.settings();
    if (!settings.conversationExecutionEnabled) {
      throw new DomainError("INVALID_STATE", "Autonomous conversation execution is disabled", 409);
    }
    await this.dialogue.maintain();
    const conversation = await this.requireConversation(conversationId);
    if (conversation.status !== "open") {
      return this.runResult(conversationId, 0, conversation.status);
    }
    if (conversation.paused) {
      return this.runResult(conversationId, 0, "paused");
    }
    await this.schedule(conversationId);
    const cap = Math.min(options?.maxTurns ?? conversation.maxMessages, conversation.maxMessages);
    let produced = 0;
    let stop = "idle";
    while (produced < cap) {
      await this.dialogue.maintain();
      const claimed = await this.claim(conversationId);
      stop = claimed.kind;
      if (claimed.kind !== "job") {
        break;
      }
      const step = await this.execute(ctx, claimed.job, claimed.token, claimed.speakerDepartmentId, provider, route);
      if (step.generated) {
        produced += 1;
      }
      if (step.childId) {
        await this.run(ctx, step.childId, provider, route, { maxTurns: cap });
        const parent = await this.requireConversation(conversationId);
        if (parent.status === "open" && !parent.paused) {
          await this.persistence.repos.autonomy.saveConversation(conversationId, { runnerStatus: "idle" });
          await this.schedule(conversationId);
          continue;
        }
        stop = parent.status;
        break;
      }
      if (!step.continue) {
        stop = step.stop;
        break;
      }
    }
    return this.runResult(conversationId, produced, stop);
  }

  async handleDelivery(
    payload: { jobId: string; conversationId: string },
    provider: InferenceProvider,
    route: InferenceRoute,
    ctx: RequestContext,
  ): Promise<{ duplicate: boolean }> {
    const job = await this.persistence.repos.autonomy.findJob(payload.jobId);
    if (!job || job.status === "completed" || job.status === "dead") {
      return { duplicate: true };
    }
    const claimed = await this.claim(payload.conversationId);
    if (claimed.kind !== "job" || claimed.job.id !== payload.jobId) {
      return { duplicate: claimed.kind === "in_flight" || job.status === "leased" };
    }
    await this.execute(ctx, claimed.job, claimed.token, claimed.speakerDepartmentId, provider, route);
    return { duplicate: false };
  }

  async pause(ctx: RequestContext, conversationId: string): Promise<void> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    await this.requireConversation(conversationId);
    await this.persistence.repos.autonomy.saveConversation(conversationId, { paused: true, runnerStatus: "paused" });
  }

  async resume(ctx: RequestContext, conversationId: string): Promise<void> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const settings = await this.persistence.repos.autonomy.settings();
    if (!settings.conversationExecutionEnabled) {
      throw new DomainError("INVALID_STATE", "Autonomous conversation execution is disabled", 409);
    }
    const current = await this.requireConversation(conversationId);
    await this.persistence.repos.autonomy.saveConversation(conversationId, {
      paused: false,
      runnerStatus: "idle",
      runnerLeaseUntil: null,
      lastError: current.lastError?.startsWith("Paused at the hard token ceiling") ? null : current.lastError,
    });
    await this.schedule(conversationId);
  }

  async status(ctx: RequestContext, conversationId: string) {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const conversation = await this.requireConversation(conversationId);
    const job = await this.persistence.repos.autonomy.findActiveJob(conversationId);
    const turns = await this.persistence.repos.autonomy.listTurns(conversationId);
    const participants = await this.persistence.repos.autonomy.listParticipants(conversationId);
    const events = await this.persistence.repos.autonomy.listContextEvents(conversationId);
    const last = turns.at(-1) ?? null;
    return {
      conversationId,
      status: conversation.status,
      outcome: conversation.outcome,
      closeReason: conversation.closeReason,
      runnerStatus: conversation.runnerStatus,
      paused: conversation.paused,
      currentSpeakerId: job?.status === "leased" ? job.speakerDepartmentId : null,
      scheduledSpeakerId: conversation.scheduledSpeakerId,
      pendingJobId: job?.id ?? null,
      lastTurnId: last?.id ?? null,
      lastSequence: last?.sequence ?? null,
      participants,
      messageCount: conversation.messageCount,
      inferenceRequests: conversation.inferenceRequests,
      inputTokens: conversation.inputTokens,
      outputTokens: conversation.outputTokens,
      lastInferenceLatencyMs: conversation.lastInferenceLatencyMs,
      lastInferenceEndpoint: conversation.lastInferenceEndpoint,
      progress: conversation.progressState,
      lastError: conversation.lastError,
      contextEvents: events,
      research: {
        status: conversation.status,
        outcome: conversation.outcome,
        closeReason: conversation.closeReason,
        finalConclusion: conversation.finalConclusion,
        unresolvedQuestions: conversation.progressState.openQuestions,
        substantialProgress: conversation.progressState.substantialProgress,
      },
      inferenceLog: conversation.progressState.inferenceLog,
      failedGenerations: conversation.progressState.failedGenerations,
    };
  }

  private async schedule(conversationId: string): Promise<void> {
    let created: { jobId: string; conversationId: string; fence: number } | null = null;
    try {
      created = await this.persistence.transaction(async (repos) => {
        const locked = await repos.autonomy.lockConversation(conversationId);
        if (!locked || locked.status !== "open" || locked.paused || locked.runnerStatus === "waiting_on_child") {
          return null;
        }
        const settings = await repos.autonomy.settings();
        if (!settings.conversationExecutionEnabled) {
          return null;
        }
        const active = await repos.autonomy.findActiveJob(conversationId);
        if (active) {
          return null;
        }
        const fence = locked.runnerFence + 1;
        const membership = await repos.autonomy.listMembership(conversationId);
        const invited = membership.find((item) => item.membership === "invited");
        const jobId = randomUUID();
        await repos.autonomy.insertJob({
          id: jobId,
          conversationId,
          idempotencyKey: `advance:${conversationId}:${fence}`,
          fence,
          status: "pending",
          action: invited ? "invitation" : "speak",
        });
        await repos.autonomy.saveConversation(conversationId, {
          runnerStatus: "scheduled",
          runnerFence: fence,
          scheduledSpeakerId: invited?.departmentId ?? null,
          lastError: null,
        });
        return { jobId, conversationId, fence };
      });
    } catch (error) {
      if (!isUnique(error)) {
        throw error;
      }
    }
    if (created && this.wake) {
      await this.wake.publish(created).catch(() => undefined);
    }
  }

  private async claim(conversationId: string): Promise<ClaimResult> {
    const settings = await this.persistence.repos.autonomy.settings();
    if (!settings.conversationExecutionEnabled) {
      return { kind: "disabled" };
    }
    if ((await this.persistence.repos.autonomy.countBlockingHumanWork()) > 0) {
      return { kind: "deferred" };
    }
    return this.persistence.transaction(async (repos) => {
      const locked = await repos.autonomy.lockConversation(conversationId);
      if (!locked) {
        return { kind: "closed" as const };
      }
      if (locked.paused || locked.runnerStatus === "paused") {
        return { kind: "paused" as const };
      }
      if (locked.status !== "open" || locked.runnerStatus === "waiting_on_child" || locked.runnerStatus === "stopped") {
        return { kind: locked.status === "open" ? "stopped" as const : "closed" as const };
      }
      await repos.autonomy.expireLeases(this.now());
      const job = await repos.autonomy.findActiveJob(conversationId);
      if (locked.messageCount >= locked.maxMessages) {
        if (job) {
          await repos.autonomy.retireJob(job.id, "message_limit");
        }
        await this.dialogueClose(repos, conversationId, "terminated", "message_limit");
        return { kind: "closed" as const };
      }
      if (!job) {
        return { kind: "idle" as const };
      }
      if (job.status === "leased" && job.leaseUntil && Date.parse(job.leaseUntil) > this.now().getTime()) {
        return { kind: "in_flight" as const };
      }
      if (job.attempt >= MAX_ATTEMPTS) {
        await repos.autonomy.retireJob(job.id, job.lastError ?? "retry limit");
        await repos.autonomy.saveConversation(conversationId, { runnerStatus: "stopped", lastError: "The conversation turn exceeded its retry limit" });
        return { kind: "stopped" as const };
      }
      const leased = await repos.autonomy.countLeasedJobs();
      if (leased >= settings.maxConcurrentConversationTurns) {
        return { kind: "backpressure" as const };
      }
      const recommendation = await this.chooseSpeaker(repos, locked, job);
      const speakerDepartmentId = recommendation?.departmentId ?? null;
      if (!speakerDepartmentId) {
        await repos.autonomy.retireJob(job.id, "no speaker");
        if (locked.messageCount >= locked.maxMessages) {
          await this.dialogueClose(repos, conversationId, "terminated", "message_limit");
        } else {
          await this.dialogueClose(repos, conversationId, "unresolved", "no_speaker");
        }
        return { kind: "closed" as const };
      }
      if ((await repos.autonomy.countLeasedForDepartment(speakerDepartmentId)) > 0) {
        return { kind: "backpressure" as const };
      }
      const token = randomUUID();
      const until = new Date(this.now().getTime() + this.leaseMs);
      const leasedOk = await repos.autonomy.leaseJob(job.id, token, until, speakerDepartmentId);
      if (!leasedOk) {
        return { kind: "in_flight" as const };
      }
      const seededProgress = this.seedDeliverables(locked);
      await repos.autonomy.saveConversation(conversationId, {
        runnerStatus: "running",
        runnerLeaseUntil: until,
        scheduledSpeakerId: speakerDepartmentId,
        recommendedSpeakerId: speakerDepartmentId,
        speakerRecommendationReason: [
          recommendation?.reason ?? "",
          locked.progressState.turnDecisions.some((decision) => decision.startsWith("flagged"))
            ? "An unverified equation is open for another department."
            : "",
        ].filter(Boolean).join(" "),
        ...(locked.progressState.deliverableParseStatus === "pending"
          ? { progressState: seededProgress }
          : {}),
      });
      const stored = await repos.autonomy.findJob(job.id);
      return stored
        ? { kind: "job" as const, job: stored, token, speakerDepartmentId }
        : { kind: "idle" as const };
    });
  }

  private async execute(
    admin: RequestContext,
    job: ConversationJob,
    token: string,
    speakerDepartmentId: string,
    provider: InferenceProvider,
    route: InferenceRoute,
  ): Promise<{ generated: boolean; continue: boolean; stop: string; childId: string | null }> {
    const conversation = await this.requireConversation(job.conversationId);
    const settings = await this.persistence.repos.autonomy.settings();
    const spent = conversation.inputTokens + conversation.outputTokens;
    if (spent >= settings.conversationHardTokenCeiling) {
      await this.persistence.repos.autonomy.saveConversation(job.conversationId, {
        paused: true,
        runnerStatus: "paused",
        lastError: "Paused at the hard token ceiling. The transcript and context are kept.",
      });
      await this.finishJob(job.id, token, true);
      return { generated: false, continue: false, stop: "paused", childId: null };
    }
    if (conversation.maxTokens < settings.conversationHardTokenCeiling) {
      await this.persistence.repos.autonomy.saveConversation(job.conversationId, { maxTokens: settings.conversationHardTokenCeiling });
    }
    const speaker = await this.agentContext(speakerDepartmentId, admin.correlationId);
    const participantIds = await this.persistence.repos.autonomy.listParticipants(job.conversationId);
    const turns = await this.persistence.repos.autonomy.listTurns(job.conversationId);
    const speakerRow = await this.persistence.repos.autonomy.department(speakerDepartmentId);
    const department = { id: speakerDepartmentId, slug: speakerRow?.slug ?? "department" };
    const prompt = await this.prompt(conversation, speakerRow?.name ?? "department", department.slug, job.action, turns);
    let attemptNumber = 0;
    let parentAttemptId: string | null = null;
    let lastAttemptId: string | null = null;
    let activeMessages: Array<{ role: "system" | "user"; content: string }> = prompt;
    let result = await this.generate(provider, route, activeMessages, department, job.conversationId);
    let inspected = inspectDecision(result.text);
    attemptNumber += 1;
    lastAttemptId = await this.captureEvidenceAttempt({
      conversationId: job.conversationId,
      department,
      messages: activeMessages,
      result,
      attemptNumber,
      parentAttemptId,
      acceptanceStatus: inspected.ok ? "partial" : "rejected",
      diagnostic: inspected.ok ? null : inspected.diagnostic,
      reason: inspected.ok ? null : "invalid_output",
      parsedOutput: inspected.ok ? (inspected.value as unknown as Record<string, unknown>) : null,
    });
    parentAttemptId = lastAttemptId;
    let recoveredFromInvalid = false;
    if (inspected.ok && inspected.value.searchQuery) {
      const found = await this.dialogue.search(speaker, job.conversationId, inspected.value.searchQuery, 5);
      const followUp = [
        ...prompt,
        {
          role: "user" as const,
          content: `Authorized transcript matches:\n${found.turns.map((turn) => `message ${turn.id}: ${turn.body}`).join("\n")}\nReturn one JSON object. Do not request another search. Do not mention JSON validation.`,
        },
      ];
      activeMessages = followUp;
      result = await this.generate(provider, route, followUp, department, job.conversationId);
      inspected = inspectDecision(result.text);
      attemptNumber += 1;
      lastAttemptId = await this.captureEvidenceAttempt({
        conversationId: job.conversationId,
        department,
        messages: followUp,
        result,
        attemptNumber,
        parentAttemptId,
        acceptanceStatus: inspected.ok ? "partial" : "rejected",
        diagnostic: inspected.ok ? null : inspected.diagnostic,
        reason: inspected.ok ? null : "invalid_output",
        parsedOutput: inspected.ok ? (inspected.value as unknown as Record<string, unknown>) : null,
      });
      parentAttemptId = lastAttemptId ?? parentAttemptId;
      if (inspected.ok) {
        inspected = { ok: true, value: { ...inspected.value, searchQuery: null } };
      }
    }
    if (!inspected.ok) {
      let corrections = 0;
      while (!inspected.ok && corrections < MAX_INVALID_CORRECTIONS) {
        const diagnostic = inspected.diagnostic;
        const failureKind = inspected.failureKind;
        await this.recordFailedGeneration(conversation, department, result, diagnostic, "invalid_output", failureKind);
        await this.accountGenerationUsage(job.conversationId, result);
        const budget = await this.canAffordCorrection(job.conversationId, route.maxOutputTokens);
        if (!budget.ok) {
          await this.terminateInvalidOutput({
            conversationId: job.conversationId,
            jobId: job.id,
            token,
            department,
            result,
            diagnostic: boundDiagnostic(`${diagnostic}; recovery stopped: ${budget.reason}`),
            reason: "invalid_output_budget",
            failureKind,
          });
          return { generated: false, continue: false, stop: "failed", childId: null };
        }
        const recoveryPrompt: Array<{ role: "system" | "user"; content: string }> = [
          { role: "system", content: `You are the ${speakerRow?.name ?? "department"} department. ${DECISION_JSON_SCHEMA}` },
          {
            role: "user",
            content:
              cleanRecoveryPrompt({
                departmentSlug: department.slug,
                openingInstruction: conversation.openingInstruction ?? conversation.topic,
                topic: conversation.topic,
                mode: conversation.progressState.recoveryMode === "none" ? "handoff" : conversation.progressState.recoveryMode,
                recentTurns: turns.map((turn) => ({ department: turn.departmentSlug, kind: turn.kind, body: turn.body })),
              }) + `\n\n${correctionInstruction(result.text, diagnostic)}`,
          },
        ];
        activeMessages = recoveryPrompt;
        const failedAttemptId = lastAttemptId;
        result = await this.generate(provider, route, recoveryPrompt, department, job.conversationId);
        inspected = inspectDecision(result.text);
        attemptNumber += 1;
        corrections += 1;
        lastAttemptId = await this.captureEvidenceAttempt({
          conversationId: job.conversationId,
          department,
          messages: recoveryPrompt,
          result,
          attemptNumber,
          parentAttemptId: failedAttemptId,
          recoveryOfAttemptId: failedAttemptId,
          acceptanceStatus: inspected.ok ? "recovered" : "rejected",
          diagnostic: inspected.ok ? null : inspected.diagnostic,
          reason: inspected.ok ? null : "invalid_output",
          parsedOutput: inspected.ok ? (inspected.value as unknown as Record<string, unknown>) : null,
        });
        parentAttemptId = lastAttemptId ?? parentAttemptId;
        recoveredFromInvalid = true;
      }
    }
    await this.persistence.repos.autonomy.saveConversation(job.conversationId, { lastInferenceLatencyMs: result.latencyMs });
    if (!inspected.ok) {
      await this.accountGenerationUsage(job.conversationId, result);
      await this.terminateInvalidOutput({
        conversationId: job.conversationId,
        jobId: job.id,
        token,
        department,
        result,
        diagnostic: inspected.diagnostic,
        reason: "invalid_output",
        failureKind: inspected.failureKind,
      });
      return { generated: false, continue: false, stop: "failed", childId: null };
    }
    let parsed = inspected.value;
    const recentBodies = turns.map((turn) => turn.body);
    const verdict = repetitionVerdict(parsed.body, turns);
    if ((isNearVerbatim(parsed.body, recentBodies) && !permitsEcho(parsed.body, parsed.kind, recentBodies)) || verdict.duplicate) {
      const repetitionPrompt: Array<{ role: "system" | "user"; content: string }> = [
        { role: "system", content: `You are the ${speakerRow?.name ?? "department"} department. ${DECISION_JSON_SCHEMA}` },
        {
          role: "user",
          content: `${cleanRecoveryPrompt({
            departmentSlug: department.slug,
            openingInstruction: conversation.openingInstruction ?? conversation.topic,
            topic: conversation.topic,
            mode: "handoff",
            recentTurns: turns.map((turn) => ({ department: turn.departmentSlug, kind: turn.kind, body: turn.body })),
          })}\n\n${repetitionCorrection(parsed.body)}`,
        },
      ];
      const rejectedForRepetition = lastAttemptId;
      if (rejectedForRepetition) {
        await this.persistence.repos.evidence.updateAttempt(rejectedForRepetition, {
          acceptanceStatus: "rejected",
          failureClass: "repetition",
          failureSymptom: verdict.reason,
          failureRootCause: null,
          failureProvisional: true,
          classificationConfidence: "observed",
          classificationEvidence:
            "Repeated dialogue content is an observed quality symptom. It is not automatically a verified reasoning deficiency.",
        }).catch(async () => {
          await this.markEvidenceCaptureFailed(job.conversationId, "failed to mark repetitive attempt");
        });
      }
      activeMessages = repetitionPrompt;
      result = await this.generate(provider, route, repetitionPrompt, department, job.conversationId);
      inspected = inspectDecision(result.text);
      attemptNumber += 1;
      lastAttemptId = await this.captureEvidenceAttempt({
        conversationId: job.conversationId,
        department,
        messages: repetitionPrompt,
        result,
        attemptNumber,
        parentAttemptId: rejectedForRepetition,
        recoveryOfAttemptId: rejectedForRepetition,
        acceptanceStatus: inspected.ok ? "recovered" : "rejected",
        diagnostic: inspected.ok ? null : inspected.diagnostic,
        reason: inspected.ok ? null : "invalid_after_repetition",
        parsedOutput: inspected.ok ? (inspected.value as unknown as Record<string, unknown>) : null,
      });
      await this.persistence.repos.autonomy.saveConversation(job.conversationId, { lastInferenceLatencyMs: result.latencyMs });
      if (!inspected.ok) {
        await this.accountGenerationUsage(job.conversationId, result);
        // One bounded schema/JSON recovery after a repetition retry — never invents a turn.
        const budget = await this.canAffordCorrection(job.conversationId, route.maxOutputTokens);
        if (budget.ok) {
          await this.recordFailedGeneration(
            conversation,
            department,
            result,
            inspected.diagnostic,
            "invalid_after_repetition",
            inspected.failureKind,
          );
          const recoveryPrompt: Array<{ role: "system" | "user"; content: string }> = [
            { role: "system", content: `You are the ${speakerRow?.name ?? "department"} department. ${DECISION_JSON_SCHEMA}` },
            {
              role: "user",
              content:
                cleanRecoveryPrompt({
                  departmentSlug: department.slug,
                  openingInstruction: conversation.openingInstruction ?? conversation.topic,
                  topic: conversation.topic,
                  mode: "handoff",
                  recentTurns: turns.map((turn) => ({ department: turn.departmentSlug, kind: turn.kind, body: turn.body })),
                }) + `\n\n${correctionInstruction(result.text, inspected.diagnostic)}\n\nDo not repeat prior transcript text.`,
            },
          ];
          activeMessages = recoveryPrompt;
          const failedAttemptId = lastAttemptId;
          result = await this.generate(provider, route, recoveryPrompt, department, job.conversationId);
          inspected = inspectDecision(result.text);
          attemptNumber += 1;
          lastAttemptId = await this.captureEvidenceAttempt({
            conversationId: job.conversationId,
            department,
            messages: recoveryPrompt,
            result,
            attemptNumber,
            parentAttemptId: failedAttemptId,
            recoveryOfAttemptId: failedAttemptId,
            acceptanceStatus: inspected.ok ? "recovered" : "rejected",
            diagnostic: inspected.ok ? null : inspected.diagnostic,
            reason: inspected.ok ? null : "invalid_after_repetition",
            parsedOutput: inspected.ok ? (inspected.value as unknown as Record<string, unknown>) : null,
          });
          await this.persistence.repos.autonomy.saveConversation(job.conversationId, { lastInferenceLatencyMs: result.latencyMs });
        }
        if (!inspected.ok) {
          await this.accountGenerationUsage(job.conversationId, result);
          await this.terminateInvalidOutput({
            conversationId: job.conversationId,
            jobId: job.id,
            token,
            department,
            result,
            diagnostic: inspected.diagnostic,
            reason: "invalid_after_repetition",
            failureKind: inspected.failureKind,
          });
          return { generated: false, continue: false, stop: "failed", childId: null };
        }
        recoveredFromInvalid = true;
      }
      parsed = inspected.value;
      const corrected = repetitionVerdict(parsed.body, turns);
      if ((isNearVerbatim(parsed.body, recentBodies) && !permitsEcho(parsed.body, parsed.kind, recentBodies)) || corrected.duplicate) {
        await this.recordFailedGeneration(conversation, department, result, corrected.reason, "repetitive");
        if (lastAttemptId) {
          await this.persistence.repos.evidence.updateAttempt(lastAttemptId, {
            acceptanceStatus: "rejected",
            failureClass: "repetition",
            failureSymptom: corrected.reason,
            failureRootCause: null,
            failureProvisional: true,
            classificationConfidence: "observed",
            classificationEvidence:
              "Repeated dialogue content is an observed quality symptom. It is not automatically a verified reasoning deficiency.",
          }).catch(async () => {
            await this.markEvidenceCaptureFailed(job.conversationId, "failed to update repetitive attempt");
          });
        }
        const others = participantIds.filter((id) => id !== department.id);
        const plan = planRecovery({ total: conversation.progressState.recoveryTotal, otherDepartmentIds: others });
        if (plan.action === "close" || !plan.departmentId) {
          await this.closeWithoutProgress(conversation, turns);
          await this.finishJob(job.id, token, true);
          return { generated: false, continue: false, stop: "unresolved", childId: null };
        }
        const latest = await this.requireConversation(job.conversationId);
        await this.persistence.repos.autonomy.saveConversation(job.conversationId, {
          progressState: {
            ...latest.progressState,
            recoveryTotal: plan.total,
            recoveryMode: plan.action,
            recoverySpeakerId: plan.departmentId,
            turnDecisions: [...latest.progressState.turnDecisions, `recovery: ${plan.action} after a repetitive draft`].slice(-12),
          },
        });
        await this.finishJob(job.id, token, true);
        await this.schedule(job.conversationId);
        return { generated: false, continue: true, stop: "recovery", childId: null };
      }
      recoveredFromInvalid = true;
    }
    const acceptance = repetitionVerdict(parsed.body, turns);
    if (acceptance.duplicate) {
      await this.recordFailedGeneration(conversation, department, result, acceptance.reason, "repetitive");
      if (lastAttemptId) {
        await this.persistence.repos.evidence.updateAttempt(lastAttemptId, {
          acceptanceStatus: "rejected",
          failureClass: "repetition",
          failureSymptom: acceptance.reason,
          failureRootCause: null,
          failureProvisional: true,
          classificationConfidence: "observed",
          classificationEvidence:
            "Repeated dialogue content is an observed quality symptom. It is not automatically a verified reasoning deficiency.",
        }).catch(async () => {
          await this.markEvidenceCaptureFailed(job.conversationId, "failed to mark repetitive attempt");
        });
      }
      const others = participantIds.filter((id) => id !== department.id);
      const plan = planRecovery({ total: conversation.progressState.recoveryTotal, otherDepartmentIds: others });
      if (plan.action === "close" || !plan.departmentId) {
        await this.closeWithoutProgress(conversation, turns);
        await this.finishJob(job.id, token, true);
        return { generated: false, continue: false, stop: "unresolved", childId: null };
      }
      const latest = await this.requireConversation(job.conversationId);
      await this.persistence.repos.autonomy.saveConversation(job.conversationId, {
        progressState: {
          ...latest.progressState,
          recoveryTotal: plan.total,
          recoveryMode: plan.action,
          recoverySpeakerId: plan.departmentId,
          turnDecisions: [...latest.progressState.turnDecisions, `recovery: ${plan.action} after a repetitive draft`].slice(-12),
        },
      });
      await this.finishJob(job.id, token, true);
      await this.schedule(job.conversationId);
      return { generated: false, continue: true, stop: "recovery", childId: null };
    }
    const math = reviewMathClaim(parsed.body, recentBodies);
    const claim = classifyClaim(parsed.kind, parsed.body);
    const latestProgress = (await this.requireConversation(job.conversationId)).progressState;
    const decisions = [...latestProgress.turnDecisions];
    if (requestsObjectiveChange(parsed.body)) {
      decisions.push("rejected: a turn asked to change the original instruction");
    }
    if (claim === "unsupported") {
      parsed = { ...parsed, kind: "response" };
      decisions.push("rejected evidence label: the assertion has no source, observation, or experiment reference");
    } else if (claim === "pending") {
      decisions.push("accepted pending verification");
    }
    if (math.status === "flagged") {
      decisions.push(`flagged mathematical claim: ${math.reasons.join(", ")} (unverified)`);
    } else if (math.status === "proposed") {
      decisions.push("mathematical claim recorded as proposed and unverified");
    }
    if (verdict.duplicate || recoveredFromInvalid) {
      decisions.push("retried: the first draft was rejected and replaced");
    }
    decisions.push(`accepted: ${acceptance.reason}`);
    const inferenceEntry = this.inferenceEntry({
      conversation,
      department,
      result,
      status: recoveredFromInvalid ? "recovered" : "accepted",
      reason: acceptance.reason,
    });
    await this.persistence.repos.autonomy.saveConversation(job.conversationId, {
      progressState: {
        ...latestProgress,
        recoveryMode: "none",
        recoverySpeakerId: null,
        turnDecisions: decisions.slice(-12),
        inferenceLog: [...latestProgress.inferenceLog, inferenceEntry].slice(-40),
      },
    });
    if (job.action === "invitation" && parsed.decision === "decline") {
      await this.dialogue.decline(speaker, job.conversationId, parsed.body);
      const completed = await this.finishJob(job.id, token, true);
      if (completed) {
        await this.schedule(job.conversationId);
      }
      return { generated: true, continue: completed, stop: "declined", childId: null };
    }
    if (job.action === "invitation") {
      await this.dialogue.accept(speaker, job.conversationId);
    }
    const kind = await this.validatedKind(job.conversationId, parsed.kind, parsed.body);
    const addressed = parsed.addressedSlug ? await this.persistence.repos.objectives.findDepartmentBySlug(parsed.addressedSlug) : null;
    const activeIds = new Set(participantIds);
    try {
      const turn = await this.dialogue.speak(speaker, provider, route, job.conversationId, {
        kind,
        instruction: parsed.body,
        idempotencyKey: `runner:${job.id}`,
        addressedDepartmentId: addressed && activeIds.has(addressed.id) ? addressed.id : null,
        prepared: {
          body: parsed.body,
          prompt,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      });
      if (lastAttemptId) {
        await this.persistence.repos.evidence.updateAttempt(lastAttemptId, {
          turnId: turn.id,
          acceptanceStatus: recoveredFromInvalid ? "recovered" : "accepted",
          parsedOutput: parsed as unknown as Record<string, unknown>,
          validationResult: acceptance.reason,
        }).catch(async () => {
          await this.markEvidenceCaptureFailed(job.conversationId, "failed to finalize accepted attempt");
        });
      }
      await this.captureClaimsAfterTurn(admin, job.conversationId, turn.id, department.id, parsed.body).catch(async (error: unknown) => {
        await this.markClaimCaptureFailed(
          job.conversationId,
          error instanceof Error ? error.message : "claim capture failed",
        );
      });
    } catch (error) {
      const latest = await this.requireConversation(job.conversationId);
      if (latest.status !== "open") {
        await this.recordLedger(job.conversationId);
        await this.finishJob(job.id, token, true);
        return { generated: true, continue: false, stop: latest.status, childId: null };
      }
      throw error;
    }
    await this.recordLedger(job.conversationId);
    let childId: string | null = null;
    if (parsed.inviteSlug) {
      const target = await this.persistence.repos.objectives.findDepartmentBySlug(parsed.inviteSlug);
      if (target && target.status === "active" && !activeIds.has(target.id)) {
        await this.dialogue.seatInvitee(speaker, job.conversationId, target.id, parsed.body).catch(async (error: unknown) => {
          await this.persistence.repos.autonomy.saveConversation(job.conversationId, {
            lastError: error instanceof Error ? error.message : "The invitation was rejected",
          });
        });
      }
    }
    if (!conversation.parentConversationId && parsed.workingGroup && parsed.workingGroup.length >= 2) {
      childId = await this.openChild(speaker, conversation, parsed.workingGroup);
    }
    const completed = await this.finishJob(job.id, token, true);
    const latest = await this.requireConversation(job.conversationId);
    if (conversation.parentConversationId && latest.status !== "open") {
      await this.persistence.repos.autonomy.saveConversation(conversation.parentConversationId, { runnerStatus: "idle" });
      await this.schedule(conversation.parentConversationId);
    }
    if (!completed || latest.status !== "open" || latest.paused || childId) {
      if (childId) {
        await this.persistence.repos.autonomy.saveConversation(job.conversationId, { runnerStatus: "waiting_on_child" });
        await this.schedule(childId);
      }
      return { generated: true, continue: false, stop: latest.status, childId };
    }
    const continuity = await this.applyContinuity(job.conversationId, speaker);
    if (continuity !== "continue") {
      return { generated: true, continue: false, stop: continuity, childId: null };
    }
    await this.schedule(job.conversationId);
    return { generated: true, continue: true, stop: "scheduled", childId: null };
  }

  private async applyContinuity(conversationId: string, speaker: RequestContext): Promise<"continue" | "paused" | "closed"> {
    const settings = await this.persistence.repos.autonomy.settings();
    const conversation = await this.requireConversation(conversationId);
    const spent = conversation.inputTokens + conversation.outputTokens;
    if (spent >= settings.conversationHardTokenCeiling) {
      await this.persistence.repos.autonomy.saveConversation(conversationId, {
        paused: true,
        runnerStatus: "paused",
        lastError: "Paused at the hard token ceiling. The transcript and context are kept.",
      });
      return "paused";
    }
    const checkpointDue = conversation.messageCount > 0 && conversation.messageCount % settings.conversationCheckpointTurns === 0;
    const overSoft = spent >= settings.conversationSoftTokenBudget;
    if (!checkpointDue && !overSoft) {
      return "continue";
    }
    const turns = await this.persistence.repos.autonomy.listTurns(conversationId);
    const assessment = assessProgress(turns.map((turn) => ({ id: turn.id, department: turn.departmentSlug, kind: turn.kind, body: turn.body })), settings.conversationCheckpointTurns);
    const progressTurns = turns.map((turn) => ({ id: turn.id, department: turn.departmentSlug, kind: turn.kind, body: turn.body, addressedDepartment: turn.addressedDepartmentSlug }));
    const checkpoint = buildCheckpoint({
      topic: conversation.topic,
      instruction: conversation.openingInstruction ?? conversation.topic,
      turns: progressTurns,
    });
    const measured = measureProgress(checkpoint, conversation.messageCount);
    const rendered = renderCheckpoint(checkpoint);
    // Reload progressState so checkpoint writes cannot wipe failedGenerations / inferenceLog.
    const latestProgress = (await this.requireConversation(conversationId)).progressState;
    const terminationReason = overSoft && !assessment.justified
      ? "soft_budget"
      : checkpointDue && assessment.decision === "conclude"
        ? "checkpoint_stalled"
        : latestProgress.terminationReason;
    await this.persistence.repos.autonomy.saveConversation(conversationId, {
      contextSummary: rendered,
      progressState: {
        openQuestions: assessment.openQuestions,
        agreements: assessment.agreements,
        disagreements: assessment.disagreements,
        contributions: assessment.contributions,
        lastCheckpointTurn: conversation.messageCount,
        lastDecision: overSoft && !assessment.justified ? "conclude" : assessment.decision,
        byDepartment: departmentContributions(progressTurns),
        substantialProgress: measured.substantial,
        progressReason: measured.reason,
        terminationReason,
        turnDecisions: latestProgress.turnDecisions,
        recoveryTotal: latestProgress.recoveryTotal,
        recoveryMode: latestProgress.recoveryMode,
        recoverySpeakerId: latestProgress.recoverySpeakerId,
        failedGenerations: latestProgress.failedGenerations,
        inferenceLog: latestProgress.inferenceLog,
        evidenceCaptureFailures: latestProgress.evidenceCaptureFailures,
        lastEvidenceCaptureError: latestProgress.lastEvidenceCaptureError,
        refutedClaimNotices: latestProgress.refutedClaimNotices,
        claimCaptureFailures: latestProgress.claimCaptureFailures,
        lastClaimCaptureError: latestProgress.lastClaimCaptureError,
        deliverableParseStatus: latestProgress.deliverableParseStatus,
        deliverables: latestProgress.deliverables,
        pendingCorrections: latestProgress.pendingCorrections,
      },
    });
    if (checkpointDue) {
      await this.persistence.repos.autonomy.insertContextEvent({
        id: randomUUID(),
        conversationId,
        departmentId: speaker.actor.departmentId,
        kind: "summary",
        query: assessment.summary.slice(0, 500),
        messageIds: turns.map((turn) => turn.id).slice(-12),
        tokens: Math.max(1, Math.ceil(assessment.summary.length / 4)),
      });
    }
    if (overSoft && !assessment.justified) {
      await this.dialogueClose(this.persistence.repos, conversationId, "unresolved", "soft_budget");
      return "closed";
    }
    if (checkpointDue && assessment.decision === "conclude") {
      await this.dialogueClose(this.persistence.repos, conversationId, "unresolved", "checkpoint_stalled");
      return "closed";
    }
    if (checkpointDue && assessment.decision === "invite" && assessment.inviteSlug) {
      const target = await this.persistence.repos.objectives.findDepartmentBySlug(assessment.inviteSlug);
      if (target && target.status === "active") {
        await this.dialogue.seatInvitee(speaker, conversationId, target.id, "Checkpoint requested this expertise").catch(() => undefined);
      }
    }
    return "continue";
  }

  private async prompt(conversation: ConversationRecord, departmentName: string, departmentSlug: string, action: ConversationJob["action"], turns: Awaited<ReturnType<Persistence["repos"]["autonomy"]["listTurns"]>>) {
    const progress = await this.ensureDeliverablesPersisted(conversation);
    const lines = turns.map((turn) => ({ id: turn.id, department: turn.departmentSlug, kind: turn.kind, body: turn.body }));
    const settings = await this.persistence.repos.autonomy.settings();
    const context = buildDialogueContext(lines, settings.contextTokenBudget);
    const goal = conversation.objectiveId ? await this.persistence.repos.objectives.getRun(conversation.objectiveId) : null;
    let childNote = "";
    if (conversation.parentConversationId) {
      childNote = "This is a working group. Report a finding the parent can use.";
    } else {
      const children = await this.childConclusions(conversation.id);
      if (children) {
        childNote = `Working-group findings:\n${children}`;
      }
    }
    const preference = preferredSpeakerForDeliverables(progress.deliverables);
    const mathAsk =
      departmentSlug === "math" && preference?.slug === "math"
        ? `Concrete calculation request: compute the open deliverable "${preference.deliverableId}" with explicit inputs; do not assert an unverified number as fact.`
        : null;
    return [
      {
        role: "system" as const,
        content: `You are the ${departmentName} department. ${DECISION_JSON_SCHEMA}`,
      },
      {
        role: "user" as const,
        content: [
          goal ? `Colony goal:\n${goal.objective}` : null,
          `Topic:\n${conversation.topic}`,
          `Original instruction:\n${conversation.openingInstruction ?? conversation.topic}`,
          "Advance the original instruction. Do not replace the objective.",
          recoveryInstruction(progress.recoveryMode),
          childNote || null,
          action === "invitation" ? "You were invited. Set decision to accept or decline." : "Set decision to speak.",
          departmentFollowUp(departmentSlug),
          mathAsk,
          progress.lastDecision === "redirect"
            ? "The recent turns are not adding a new contribution. Add evidence, a calculation, a question, or a proposal, or propose closure."
            : null,
          progress.turnDecisions.filter((decision) => decision.startsWith("flagged")).slice(-2).join("\n") || null,
          progress.refutedClaimNotices.length
            ? [
              "Independent verification feedback (not model consensus):",
              "Distinguish verified calculator results, refuted claims, and unresolved questions. Repeated LLM assertions do not make unverified claims verified.",
              ...progress.refutedClaimNotices.slice(-3),
            ].join("\n")
            : null,
          progress.pendingCorrections.length
            ? [
              "Required corrections before a deliverable can be treated as settled:",
              ...progress.pendingCorrections.slice(-4),
            ].join("\n")
            : null,
          renderDeliverableChecklist(progress.deliverables, progress.deliverableParseStatus),
          progress.deliverables.some((item) => item.status === "verified")
            ? [
              "Verified calculator results (may be cited; do not re-assert unverified numbers as facts):",
              ...progress.deliverables
                .filter((item) => item.status === "verified")
                .map((item) =>
                  `- ${item.label}`
                  + (item.verifiedValue !== null ? ` = ${item.verifiedValue}` : "")
                  + (item.claimId ? ` (claim ${item.claimId})` : ""),
                ),
            ].join("\n")
            : null,
          context.summary ? `Omitted transcript excerpts:\n${context.summary}` : null,
          conversation.contextSummary ? `Checkpoint:\n${conversation.contextSummary}` : null,
          context.verbatim.length ? `Recent transcript:\n${context.verbatim.map((turn) => `message ${turn.id} ${turn.department} (${turn.kind}): ${turn.body}`).join("\n")}` : null,
        ].filter(Boolean).join("\n\n"),
      },
    ];
  }

  private async generate(
    provider: InferenceProvider,
    route: InferenceRoute,
    messages: Array<{ role: "system" | "user"; content: string }>,
    department: { id: string; slug: string },
    conversationId: string,
  ): Promise<InferenceResult & { routingModel: string; routingEndpoint: string }> {
    const selected = selectConversationInference({
      departmentId: department.id,
      departmentSlug: department.slug,
      shared: provider,
      route,
    });
    logConversationInference(selected.metadata);
    await this.persistence.repos.autonomy.saveConversation(conversationId, { lastInferenceEndpoint: selected.metadata });
    const result = await selected.provider.generate({
      requestId: randomUUID(),
      registryModelId: QWEN3_8B_MODEL_ID,
      modelAlias: route.alias,
      messages,
      temperature: route.temperature,
      maxOutputTokens: route.maxOutputTokens,
      timeoutMs: route.timeoutMs,
      jsonObject: true,
      jsonSchema: DECISION_RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
    });
    return {
      ...result,
      routingModel: selected.model,
      routingEndpoint: selected.endpoint ?? "shared",
    };
  }

  private async validatedKind(conversationId: string, kind: DialogueKind, body: string): Promise<DialogueKind> {
    if (kind !== "resolution") {
      return kind;
    }
    const conversation = await this.requireConversation(conversationId);
    const progress = await this.ensureDeliverablesPersisted(conversation);
    const gate = evaluateConclusionGate({
      parseStatus: progress.deliverableParseStatus,
      deliverables: progress.deliverables,
      conclusionBody: body,
    });
    if (!gate.ok) {
      return "response";
    }
    const turns = await this.persistence.repos.autonomy.listTurns(conversationId);
    if (turns.some((turn) => turn.kind === "evidence") || UNCERTAIN.test(body) || progress.deliverables.some((item) => item.status === "verified")) {
      return "resolution";
    }
    return "response";
  }

  private async chooseSpeaker(repos: Persistence["repos"], conversation: ConversationRecord, job: ConversationJob): Promise<{ departmentId: string; reason: string } | null> {
    if (job.action === "invitation") {
      const membership = await repos.autonomy.listMembership(conversation.id);
      const invited = membership.find((item) => item.membership === "invited")?.departmentId ?? null;
      return invited ? { departmentId: invited, reason: "invitation" } : null;
    }
    const participants = [];
    for (const id of await repos.autonomy.listParticipants(conversation.id)) {
      const department = await repos.autonomy.department(id);
      if (department) {
        participants.push({ id: department.id, slug: department.slug, name: department.name });
      }
    }
    if (conversation.progressState.recoveryMode !== "none" && conversation.progressState.recoverySpeakerId) {
      const recovered = participants.find((participant) => participant.id === conversation.progressState.recoverySpeakerId);
      if (recovered) {
        return {
          departmentId: recovered.id,
          reason: conversation.progressState.recoveryMode === "synthesis"
            ? "synthesis after a repetitive draft"
            : "handoff after a repetitive draft",
        };
      }
    }
    const progress = this.seedDeliverables(conversation);
    const turns = await repos.autonomy.listTurns(conversation.id);
    const preference = preferredSpeakerForDeliverables(progress.deliverables);
    if (preference) {
      const preferred = participants.find((participant) => participant.slug === preference.slug);
      if (preferred) {
        const allowed = maySpeak({
          departmentId: preferred.id,
          participantIds: participants.map((participant) => participant.id),
          turns,
        });
        if (allowed.allowed) {
          const concrete =
            preference.slug === "math"
              ? " Provide a concrete calculator-backed calculation for the missing or refuted numerical deliverable."
              : preference.slug === "science"
                ? " Address the unsupported physical assumption or thrust/duration tradeoff with an explicit, qualified statement."
                : " Resolve the contradiction and synthesize only from independently verified values.";
          return {
            departmentId: preferred.id,
            reason: `${preference.reason}.${concrete}`,
          };
        }
      }
    }
    const choice = orchestrationRecommendation({
      participants,
      turns,
      topic: conversation.topic,
      remainingMessages: Math.max(0, conversation.maxMessages - conversation.messageCount),
    });
    return choice ? { departmentId: choice.departmentId, reason: choice.reason } : null;
  }

  /** In-memory only — safe inside claim() transactions that already lock the conversation row. */
  private seedDeliverables(conversation: ConversationRecord): ConversationProgress {
    if (conversation.progressState.deliverableParseStatus !== "pending") {
      return conversation.progressState;
    }
    const derived = deriveDeliverables(conversation.openingInstruction ?? conversation.topic, conversation.topic);
    return {
      ...conversation.progressState,
      deliverableParseStatus: derived.parseStatus,
      deliverables: derived.deliverables,
      pendingCorrections: conversation.progressState.pendingCorrections ?? [],
    };
  }

  /** Persist checklist outside lock-holding claim transactions. */
  private async ensureDeliverablesPersisted(conversation: ConversationRecord): Promise<ConversationProgress> {
    const progressState = this.seedDeliverables(conversation);
    if (conversation.progressState.deliverableParseStatus === "pending") {
      await this.persistence.repos.autonomy.saveConversation(conversation.id, { progressState });
    }
    return progressState;
  }

  private async recordLedger(conversationId: string): Promise<void> {
    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      return;
    }
    const turns = await this.persistence.repos.autonomy.listTurns(conversationId);
    await this.persistence.repos.autonomy.saveConversation(conversationId, {
      progressState: {
        ...conversation.progressState,
        byDepartment: departmentContributions(turns.map((turn) => ({ department: turn.departmentSlug, kind: turn.kind }))),
      },
    });
  }

  private async openChild(ctx: RequestContext, parent: ConversationRecord, slugs: string[]): Promise<string | null> {
    const ids: string[] = [];
    for (const slug of slugs) {
      const department = await this.persistence.repos.objectives.findDepartmentBySlug(slug);
      if (department?.status === "active") {
        ids.push(department.id);
      }
    }
    if (ctx.actor.departmentId && !ids.includes(ctx.actor.departmentId)) {
      ids.push(ctx.actor.departmentId);
    }
    if (ids.length < 2) {
      return null;
    }
    return this.dialogue.openSeated(ctx, {
      topic: `${parent.topic} working group`,
      objectiveId: parent.objectiveId,
      departmentIds: ids.slice(0, 4),
      parentConversationId: parent.id,
    });
  }

  private async childConclusions(conversationId: string): Promise<string | null> {
    const rows = await this.persistence.repos.autonomy.listConversations(100);
    const children = rows.filter((row) => row.parentConversationId === conversationId && row.finalConclusion);
    if (!children.length) {
      return null;
    }
    return children.map((row) => `message parent-link ${row.id}: ${row.finalConclusion}`).join("\n");
  }

  private async finishJob(id: string, token: string, ok: boolean, error = "invalid model output"): Promise<boolean> {
    if (!ok) {
      return this.persistence.repos.autonomy.releaseJob(id, token, error);
    }
    return this.persistence.repos.autonomy.completeJob(id, token, this.now());
  }

  private async runResult(conversationId: string, produced: number, stop: string): Promise<ConversationRunResult> {
    const conversation = await this.requireConversation(conversationId);
    return {
      conversationId,
      produced,
      stop,
      execution: { stop, produced },
      research: {
        status: conversation.status,
        outcome: conversation.outcome,
        closeReason: conversation.closeReason,
        finalConclusion: conversation.finalConclusion,
        unresolvedQuestions: conversation.progressState.openQuestions,
        substantialProgress: conversation.progressState.substantialProgress,
        budget: {
          messagesRemaining: Math.max(0, conversation.maxMessages - conversation.messageCount),
          tokensSpent: conversation.inputTokens + conversation.outputTokens,
          maxMessages: conversation.maxMessages,
          maxTokens: conversation.maxTokens,
        },
      },
    };
  }

  private inferenceEntry(input: {
    conversation: ConversationRecord;
    department: { id: string; slug: string };
    result: InferenceResult & { routingModel?: string; routingEndpoint?: string };
    status: InferenceTurnLog["status"];
    reason: string;
  }): InferenceTurnLog {
    return {
      at: this.now().toISOString(),
      departmentId: input.department.id,
      departmentSlug: input.department.slug,
      model: (input.result.routingModel ?? input.conversation.lastInferenceEndpoint ?? "unknown").slice(0, 80),
      endpoint: (input.result.routingEndpoint ?? "shared").slice(0, 120),
      latencyMs: input.result.latencyMs,
      inputTokens: input.result.usage.inputTokens ?? null,
      outputTokens: input.result.usage.outputTokens ?? null,
      status: input.status,
      reason: input.reason.slice(0, 200),
    };
  }

  private async captureEvidenceAttempt(input: {
    conversationId: string;
    department: { id: string; slug: string };
    messages: Array<{ role: string; content: string }>;
    result: InferenceResult & { routingModel?: string; routingEndpoint?: string };
    attemptNumber: number;
    parentAttemptId: string | null;
    recoveryOfAttemptId?: string | null;
    acceptanceStatus: AcceptanceStatus;
    diagnostic: string | null;
    reason: string | null;
    parsedOutput: Record<string, unknown> | null;
  }): Promise<string | null> {
    const recorded = await this.evidence.captureAttempt({
      conversationId: input.conversationId,
      departmentId: input.department.id,
      messages: input.messages,
      rawOutput: input.result.text,
      parsedOutput: input.parsedOutput,
      validationResult: input.diagnostic,
      inferenceEndpoint: input.result.routingEndpoint ?? "shared",
      attemptNumber: input.attemptNumber,
      parentAttemptId: input.parentAttemptId,
      recoveryOfAttemptId: input.recoveryOfAttemptId ?? null,
      modelRegistryId: QWEN3_8B_MODEL_ID,
      modelVersion: input.result.routingModel ?? null,
      adapterId: null,
      adapterVersion: null,
      inputTokens: input.result.usage.inputTokens ?? null,
      outputTokens: input.result.usage.outputTokens ?? null,
      latencyMs: input.result.latencyMs,
      acceptanceStatus: input.acceptanceStatus,
      diagnostic: input.diagnostic,
      reason: input.reason,
    });
    if (!recorded) {
      await this.markEvidenceCaptureFailed(input.conversationId, "durable inference attempt capture failed");
      return null;
    }
    return recorded.id;
  }

  private async markEvidenceCaptureFailed(conversationId: string, error: string): Promise<void> {
    const latest = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!latest) {
      return;
    }
    await this.persistence.repos.autonomy.saveConversation(conversationId, {
      progressState: {
        ...latest.progressState,
        evidenceCaptureFailures: latest.progressState.evidenceCaptureFailures + 1,
        lastEvidenceCaptureError: redactSensitive(error).slice(0, 240),
      },
    });
  }

  private async captureClaimsAfterTurn(
    ctx: RequestContext,
    conversationId: string,
    turnId: string,
    proposingDepartmentId: string,
    body: string,
  ): Promise<void> {
    const turns = await this.persistence.repos.autonomy.listTurns(conversationId);
    const contextBodies = turns
      .filter((turn) => turn.id !== turnId)
      .slice(-6)
      .map((turn) => turn.body);
    const result = await this.claims.captureTurnClaims(ctx, {
      conversationId,
      turnId,
      proposingDepartmentId,
      body,
      contextBodies,
    });
    const latest = await this.requireConversation(conversationId);
    const seeded = await this.ensureDeliverablesPersisted(latest);
    const claims = await this.persistence.repos.claims.listClaimsByConversation(conversationId, 100);
    const reconciled = reconcileDeliverables({
      deliverables: seeded.deliverables,
      claims,
      recentBodies: turns.map((turn) => turn.body),
    });
    const decisions = [...seeded.turnDecisions];
    if (result.verified > 0) {
      decisions.push(`verified claims: ${result.verified}`);
    }
    if (result.refuted > 0) {
      decisions.push(`refuted claims: ${result.refuted}`);
    }
    if (result.inconclusive > 0) {
      decisions.push(`inconclusive claims: ${result.inconclusive}`);
    }
    const completed = reconciled.deliverables.filter((item) => item.status === "verified").length;
    const previouslyCompleted = seeded.deliverables.filter((item) => item.status === "verified").length;
    if (completed > previouslyCompleted) {
      decisions.push(`deliverables verified: ${completed}`);
    }
    const repeatedUnsupported =
      result.inconclusive > 0
      && isNearVerbatim(
        body,
        turns.filter((turn) => turn.id !== turnId).map((turn) => turn.body),
      );
    if (repeatedUnsupported) {
      decisions.push("flagged: repeated unsupported assertion");
    }
    const substantial =
      completed > 0
      || result.verified > 0
      || result.refuted > 0
      || seeded.substantialProgress;
    const progressReason =
      completed > 0
        ? `${completed} deliverable(s) independently verified.`
        : result.verified > 0
          ? "New independently verified evidence was recorded."
          : result.refuted > 0
            ? "A contradiction was resolved by independent refutation."
            : seeded.progressReason;
    await this.persistence.repos.autonomy.saveConversation(conversationId, {
      progressState: {
        ...seeded,
        turnDecisions: decisions.slice(-12),
        refutedClaimNotices: [...seeded.refutedClaimNotices, ...result.refutedNotices].slice(-8),
        claimCaptureFailures: seeded.claimCaptureFailures + result.errors.length,
        lastClaimCaptureError: result.errors.at(-1)
          ? redactSensitive(result.errors.at(-1)!).slice(0, 240)
          : seeded.lastClaimCaptureError,
        deliverables: reconciled.deliverables,
        pendingCorrections: reconciled.pendingCorrections.slice(-8),
        substantialProgress: substantial,
        progressReason,
      },
    });
  }

  private async markClaimCaptureFailed(conversationId: string, error: string): Promise<void> {
    const latest = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!latest) {
      return;
    }
    await this.persistence.repos.autonomy.saveConversation(conversationId, {
      progressState: {
        ...latest.progressState,
        claimCaptureFailures: latest.progressState.claimCaptureFailures + 1,
        lastClaimCaptureError: redactSensitive(error).slice(0, 240),
      },
    });
  }

  private async recordFailedGeneration(
    conversation: ConversationRecord,
    department: { id: string; slug: string },
    result: InferenceResult & { routingModel?: string; routingEndpoint?: string },
    diagnostic: string,
    reason: string,
    failureKind?: DecisionFailureKind,
  ): Promise<void> {
    const latest = await this.requireConversation(conversation.id);
    const entry = this.inferenceEntry({
      conversation: latest,
      department,
      result,
      status: "failed",
      reason,
    });
    const classified = classifyFailure(diagnostic, reason);
    const failureClass: FailureClass =
      failureKind === "truncated"
        ? "json_invalid"
        : failureKind === "schema_invalid"
          ? "schema_invalid"
          : failureKind === "contribution_invalid"
            ? "meta_validation_chatter"
            : failureKind === "serialization_error"
              ? "serialization_error"
              : failureKind === "json_invalid"
                ? "json_invalid"
                : classified.failureClass;
    // Persist a bounded fingerprint of the raw generation — never unbounded model text.
    const outputDigest = result.text
      ? `len=${result.text.length};head=${redactSensitive(result.text).slice(0, 48)}`
      : "empty";
    await this.persistence.repos.autonomy.saveConversation(conversation.id, {
      progressState: {
        ...latest.progressState,
        failedGenerations: [
          ...latest.progressState.failedGenerations,
          {
            at: this.now().toISOString(),
            departmentSlug: department.slug,
            reason,
            diagnostic: redactSensitive(diagnostic).slice(0, 240),
            failureClass,
            outputDigest: redactSensitive(outputDigest).slice(0, 96),
          },
        ].slice(-20),
        inferenceLog: [...latest.progressState.inferenceLog, entry].slice(-40),
        turnDecisions: [...latest.progressState.turnDecisions, `rejected: ${reason}`].slice(-12),
      },
    });
  }

  private async accountGenerationUsage(
    conversationId: string,
    result: InferenceResult,
  ): Promise<void> {
    await this.persistence.repos.autonomy.recordInferenceUsage(conversationId, {
      requests: 1,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      at: this.now(),
    });
  }

  private async canAffordCorrection(
    conversationId: string,
    maxOutputTokens: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const settings = await this.persistence.repos.autonomy.settings();
    const conversation = await this.requireConversation(conversationId);
    const spent = conversation.inputTokens + conversation.outputTokens;
    const ceiling = Math.min(conversation.maxTokens, settings.conversationHardTokenCeiling);
    if (spent >= ceiling) {
      return { ok: false, reason: "hard token ceiling reached" };
    }
    if (spent + Math.max(1, maxOutputTokens) > ceiling) {
      return { ok: false, reason: "insufficient token budget for another correction" };
    }
    if (conversation.messageCount >= conversation.maxMessages) {
      return { ok: false, reason: "message limit reached" };
    }
    return { ok: true };
  }

  private async terminateInvalidOutput(input: {
    conversationId: string;
    jobId: string;
    token: string;
    department: { id: string; slug: string };
    result: InferenceResult & { routingModel?: string; routingEndpoint?: string };
    diagnostic: string;
    reason: string;
    failureKind?: DecisionFailureKind;
  }): Promise<void> {
    await this.recordFailedGeneration(
      await this.requireConversation(input.conversationId),
      input.department,
      input.result,
      input.diagnostic,
      input.reason,
      input.failureKind,
    );
    const latest = await this.requireConversation(input.conversationId);
    const lastError = boundDiagnostic(input.diagnostic.replace(/^model_invalid:\s*/i, ""));
    await this.persistence.repos.autonomy.saveConversation(input.conversationId, {
      lastError,
      progressState: {
        ...latest.progressState,
        terminationReason: "model_invalid",
        recoveryMode: "none",
        recoverySpeakerId: null,
        failedGenerations: latest.progressState.failedGenerations,
        inferenceLog: latest.progressState.inferenceLog,
        turnDecisions: latest.progressState.turnDecisions,
        evidenceCaptureFailures: latest.progressState.evidenceCaptureFailures,
        lastEvidenceCaptureError: latest.progressState.lastEvidenceCaptureError,
        refutedClaimNotices: latest.progressState.refutedClaimNotices,
        claimCaptureFailures: latest.progressState.claimCaptureFailures,
        lastClaimCaptureError: latest.progressState.lastClaimCaptureError,
        deliverableParseStatus: latest.progressState.deliverableParseStatus,
        deliverables: latest.progressState.deliverables,
        pendingCorrections: latest.progressState.pendingCorrections,
      },
    });
    await this.dialogueClose(this.persistence.repos, input.conversationId, "terminated", "model_invalid");
    await this.finishJob(input.jobId, input.token, false, lastError);
  }

  private async closeWithoutProgress(conversation: ConversationRecord, turns: Awaited<ReturnType<Persistence["repos"]["autonomy"]["listTurns"]>>): Promise<void> {
    const checkpoint = buildCheckpoint({
      topic: conversation.topic,
      instruction: conversation.openingInstruction ?? conversation.topic,
      turns: turns.map((turn) => ({ id: turn.id, department: turn.departmentSlug, kind: turn.kind, body: turn.body, addressedDepartment: turn.addressedDepartmentSlug })),
    });
    const unresolved = checkpoint.openQuestions.slice(0, 4).join(" | ") || "none recorded";
    const latest = await this.requireConversation(conversation.id);
    await this.persistence.repos.autonomy.saveConversation(conversation.id, {
      lastError: `no_progress: bounded recovery ended. Unresolved questions: ${unresolved}`,
      progressState: {
        ...latest.progressState,
        terminationReason: "no_progress",
        recoveryMode: "none",
        recoverySpeakerId: null,
        turnDecisions: [...latest.progressState.turnDecisions, "rejected: bounded recovery produced no new contribution"].slice(-12),
      },
    });
    await this.dialogueClose(this.persistence.repos, conversation.id, "unresolved", "no_progress");
  }

  private async dialogueClose(repos: Persistence["repos"], conversationId: string, status: "resolved" | "unresolved" | "terminated", reason: string): Promise<void> {
    const outcome = reason === "model_invalid" || reason === "failed"
      ? "failed"
      : reason === "message_limit" || reason === "token_limit"
        ? "budget_exhausted"
        : status === "resolved"
          ? "resolved"
          : "unresolved";
    // Reload so termination never clobbers failedGenerations / inferenceLog written earlier in the turn.
    const latest = await repos.autonomy.findConversation(conversationId);
    await repos.autonomy.saveConversation(conversationId, {
      status,
      closeReason: reason,
      outcome,
      closedAt: this.now(),
      runnerStatus: "stopped",
      ...(latest
        ? {
            progressState: {
              ...latest.progressState,
              terminationReason: latest.progressState.terminationReason ?? reason,
              failedGenerations: latest.progressState.failedGenerations,
              inferenceLog: latest.progressState.inferenceLog,
            },
          }
        : {}),
    });
  }

  private async agentContext(departmentId: string, correlationId: string): Promise<RequestContext> {
    const agent = await this.persistence.repos.autonomy.departmentAgent(departmentId);
    if (!agent) {
      throw new DomainError("INVALID_STATE", "The selected department has no agent", 409);
    }
    return {
      actor: {
        principalId: agent.id,
        principalType: "agent",
        agentId: agent.id,
        departmentId,
        role: "department_agent",
        permissions: [],
      },
      correlationId,
    };
  }

  private async requireConversation(id: string): Promise<ConversationRecord> {
    const conversation = await this.persistence.repos.autonomy.findConversation(id);
    if (!conversation) {
      throw notFound("Conversation", id);
    }
    return conversation;
  }
}

function isUnique(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === "object" && current && "code" in current && (current as { code?: string }).code === "23505") {
      return true;
    }
    current = typeof current === "object" && current && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
