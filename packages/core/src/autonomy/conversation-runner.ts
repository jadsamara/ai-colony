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
import { assessProgress, departmentFollowUp, isNearVerbatim, permitsEcho, repetitionCorrection } from "./conversation-quality.js";
import { logConversationInference, selectConversationInference } from "./conversation-routing.js";
import type { DialogueService } from "./dialogue-service.js";
import { redactSensitive } from "./policy.js";
import type { ConversationJob, ConversationRecord } from "./repository.js";
import { buildDialogueContext, selectSpeaker } from "./speakers.js";

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 3;
const UNCERTAIN = /uncertain|cannot verify|not established|unresolved/i;
const decisionSchema = z.object({
  kind: z.enum(["question", "response", "proposal", "challenge", "evidence", "counterargument", "agreement", "disagreement", "resolution", "close"]),
  body: z.string().trim().min(1).max(4_000),
  addressedSlug: z.string().trim().min(1).max(64).nullable().optional(),
  inviteSlug: z.string().trim().min(1).max(64).nullable().optional(),
  decision: z.enum(["speak", "accept", "decline"]).optional(),
  searchQuery: z.string().trim().min(1).max(200).nullable().optional(),
  workingGroup: z.array(z.string().trim().min(1).max(64)).max(4).optional(),
});

const DIAGNOSTIC_LIMIT = 240;
const PREVIOUS_OUTPUT_LIMIT = 500;

export const DECISION_JSON_SCHEMA = [
  "Return one JSON object and no other text.",
  "Required JSON schema: {\"kind\":\"question\"|\"response\"|\"proposal\"|\"challenge\"|\"evidence\"|\"counterargument\"|\"agreement\"|\"disagreement\"|\"resolution\"|\"close\",\"body\":\"string\"}.",
  "kind is required and must be one of: question, response, proposal, challenge, evidence, counterargument, agreement, disagreement, resolution, close.",
  "body is required and must be a non-empty string of at most 4000 characters.",
  "Optional fields: addressedSlug (string or null), inviteSlug (string or null), decision (speak, accept, or decline), searchQuery (string or null), workingGroup (array of at most 4 department slugs).",
  "Do not omit kind or body. Do not invent fields. Do not invent citations.",
].join(" ");

export type DecisionDraft = z.infer<typeof decisionSchema>;

export type DecisionInspection =
  | { ok: true; value: DecisionDraft }
  | { ok: false; diagnostic: string };

export function inspectDecision(text: string): DecisionInspection {
  let extracted: unknown;
  try {
    extracted = extractJsonObject(text);
  } catch (error) {
    const reason = error instanceof Error && error.message.includes("did not contain a JSON object")
      ? "output was not a JSON object"
      : "output was not valid JSON";
    return { ok: false, diagnostic: boundDiagnostic(reason) };
  }
  const parsed = decisionSchema.safeParse(extracted);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map(formatIssue);
    return { ok: false, diagnostic: boundDiagnostic(issues.join("; ") || "output did not match the schema") };
  }
  return { ok: true, value: parsed.data };
}

export function correctionInstruction(previousOutput: string, diagnostic: string): string {
  const clipped = redactSensitive(previousOutput).slice(0, PREVIOUS_OUTPUT_LIMIT);
  return [
    "The previous JSON failed validation. Correct it.",
    `Validation errors: ${diagnostic}`,
    "Previous output:",
    clipped,
    DECISION_JSON_SCHEMA,
    "Return one JSON object that matches the schema.",
  ].join("\n");
}

function formatIssue(issue: { code: string; path: PropertyKey[]; message: string }): string {
  const path = issue.path.length ? issue.path.map(String).join(".") : "object";
  if (issue.code === "invalid_enum_value" || issue.code === "invalid_value") {
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
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly dialogue: DialogueService,
    private readonly now: () => Date = () => new Date(),
    private readonly wake?: ConversationWake,
    private readonly leaseMs = LEASE_MS,
  ) {}

  async run(
    ctx: RequestContext,
    conversationId: string,
    provider: InferenceProvider,
    route: InferenceRoute,
    options?: { maxTurns?: number },
  ): Promise<{ conversationId: string; produced: number; stop: string }> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const settings = await this.persistence.repos.autonomy.settings();
    if (!settings.conversationExecutionEnabled) {
      throw new DomainError("INVALID_STATE", "Autonomous conversation execution is disabled", 409);
    }
    await this.dialogue.maintain();
    const conversation = await this.requireConversation(conversationId);
    if (conversation.status !== "open") {
      return { conversationId, produced: 0, stop: conversation.status };
    }
    if (conversation.paused) {
      return { conversationId, produced: 0, stop: "paused" };
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
    return { conversationId, produced, stop };
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
      const speakerDepartmentId = await this.chooseSpeaker(repos, locked, job);
      if (!speakerDepartmentId) {
        await repos.autonomy.retireJob(job.id, "no speaker");
        await this.dialogueClose(repos, conversationId, "unresolved", "no_speaker");
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
      await repos.autonomy.saveConversation(conversationId, {
        runnerStatus: "running",
        runnerLeaseUntil: until,
        scheduledSpeakerId: speakerDepartmentId,
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
    let result = await this.generate(provider, route, prompt, department, job.conversationId);
    let inspected = inspectDecision(result.text);
    if (inspected.ok && inspected.value.searchQuery) {
      const found = await this.dialogue.search(speaker, job.conversationId, inspected.value.searchQuery, 5);
      const followUp = [
        ...prompt,
        {
          role: "user" as const,
          content: `Previous output:\n${result.text}\nAuthorized transcript matches:\n${found.turns.map((turn) => `message ${turn.id}: ${turn.body}`).join("\n")}\nReturn one JSON object. Do not request another search.`,
        },
      ];
      result = await this.generate(provider, route, followUp, department, job.conversationId);
      inspected = inspectDecision(result.text);
      if (inspected.ok) {
        inspected = { ok: true, value: { ...inspected.value, searchQuery: null } };
      }
    }
    if (!inspected.ok) {
      const diagnostic = inspected.diagnostic;
      result = await this.generate(provider, route, [
        ...prompt,
        { role: "user", content: correctionInstruction(result.text, diagnostic) },
      ], department, job.conversationId);
      inspected = inspectDecision(result.text);
    }
    await this.persistence.repos.autonomy.saveConversation(job.conversationId, { lastInferenceLatencyMs: result.latencyMs });
    if (!inspected.ok) {
      await this.persistence.repos.autonomy.saveConversation(job.conversationId, { lastError: inspected.diagnostic });
      await this.dialogueClose(this.persistence.repos, job.conversationId, "terminated", "model_invalid");
      await this.finishJob(job.id, token, false, inspected.diagnostic);
      return { generated: true, continue: false, stop: "failed", childId: null };
    }
    let parsed = inspected.value;
    const recentBodies = turns.map((turn) => turn.body);
    if (isNearVerbatim(parsed.body, recentBodies) && !permitsEcho(parsed.body, parsed.kind, recentBodies)) {
      result = await this.generate(provider, route, [
        ...prompt,
        { role: "user", content: `${repetitionCorrection(parsed.body)}\n${DECISION_JSON_SCHEMA}` },
      ], department, job.conversationId);
      inspected = inspectDecision(result.text);
      await this.persistence.repos.autonomy.saveConversation(job.conversationId, { lastInferenceLatencyMs: result.latencyMs });
      if (!inspected.ok) {
        await this.persistence.repos.autonomy.saveConversation(job.conversationId, { lastError: inspected.diagnostic });
        await this.dialogueClose(this.persistence.repos, job.conversationId, "terminated", "model_invalid");
        await this.finishJob(job.id, token, false, inspected.diagnostic);
        return { generated: true, continue: false, stop: "failed", childId: null };
      }
      parsed = inspected.value;
      if (isNearVerbatim(parsed.body, recentBodies) && !permitsEcho(parsed.body, parsed.kind, recentBodies)) {
        await this.dialogueClose(this.persistence.repos, job.conversationId, "unresolved", "no_progress");
        await this.finishJob(job.id, token, true);
        return { generated: false, continue: false, stop: "unresolved", childId: null };
      }
    }
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
      await this.dialogue.speak(speaker, provider, route, job.conversationId, {
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
    } catch (error) {
      const latest = await this.requireConversation(job.conversationId);
      if (latest.status !== "open") {
        await this.finishJob(job.id, token, true);
        return { generated: true, continue: false, stop: latest.status, childId: null };
      }
      throw error;
    }
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
    const progressTurns = turns.map((turn) => ({ id: turn.id, department: turn.departmentSlug, kind: turn.kind, body: turn.body }));
    const assessment = assessProgress(progressTurns, settings.conversationCheckpointTurns);
    await this.persistence.repos.autonomy.saveConversation(conversationId, {
      contextSummary: assessment.summary,
      progressState: {
        openQuestions: assessment.openQuestions,
        agreements: assessment.agreements,
        disagreements: assessment.disagreements,
        contributions: assessment.contributions,
        lastCheckpointTurn: conversation.messageCount,
        lastDecision: overSoft && !assessment.justified ? "conclude" : assessment.decision,
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
          childNote || null,
          action === "invitation" ? "You were invited. Set decision to accept or decline." : "Set decision to speak.",
          departmentFollowUp(departmentSlug),
          conversation.progressState.lastDecision === "redirect"
            ? "The recent turns are not adding a new contribution. Add evidence, a calculation, a question, or a proposal, or propose closure."
            : null,
          context.summary ? `Earlier context:\n${context.summary}` : conversation.contextSummary ? `Checkpoint summary:\n${conversation.contextSummary}` : null,
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
  ): Promise<InferenceResult> {
    const selected = selectConversationInference({
      departmentId: department.id,
      departmentSlug: department.slug,
      shared: provider,
      route,
    });
    logConversationInference(selected.metadata);
    await this.persistence.repos.autonomy.saveConversation(conversationId, { lastInferenceEndpoint: selected.metadata });
    return selected.provider.generate({
      requestId: randomUUID(),
      registryModelId: QWEN3_8B_MODEL_ID,
      modelAlias: route.alias,
      messages,
      temperature: route.temperature,
      maxOutputTokens: route.maxOutputTokens,
      timeoutMs: route.timeoutMs,
      jsonObject: true,
    });
  }

  private async validatedKind(conversationId: string, kind: DialogueKind, body: string): Promise<DialogueKind> {
    if (kind !== "resolution") {
      return kind;
    }
    const turns = await this.persistence.repos.autonomy.listTurns(conversationId);
    if (turns.some((turn) => turn.kind === "evidence") || UNCERTAIN.test(body)) {
      return "resolution";
    }
    return "response";
  }

  private async chooseSpeaker(repos: Persistence["repos"], conversation: ConversationRecord, job: ConversationJob): Promise<string | null> {
    if (job.action === "invitation") {
      const membership = await repos.autonomy.listMembership(conversation.id);
      return membership.find((item) => item.membership === "invited")?.departmentId ?? null;
    }
    const participants = [];
    for (const id of await repos.autonomy.listParticipants(conversation.id)) {
      const department = await repos.autonomy.department(id);
      if (department) {
        participants.push({ id: department.id, slug: department.slug, name: department.name });
      }
    }
    const turns = await repos.autonomy.listTurns(conversation.id);
    const choice = selectSpeaker({
      participants,
      turns,
      topic: conversation.topic,
      remainingMessages: Math.max(0, conversation.maxMessages - conversation.messageCount),
    });
    return choice?.departmentId ?? null;
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

  private async dialogueClose(repos: Persistence["repos"], conversationId: string, status: "resolved" | "unresolved" | "terminated", reason: string): Promise<void> {
    const outcome = reason === "model_invalid" || reason === "failed"
      ? "failed"
      : reason === "message_limit" || reason === "token_limit"
        ? "budget_exhausted"
        : status === "resolved"
          ? "resolved"
          : "unresolved";
    await repos.autonomy.saveConversation(conversationId, {
      status,
      closeReason: reason,
      outcome,
      closedAt: this.now(),
      runnerStatus: "stopped",
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
