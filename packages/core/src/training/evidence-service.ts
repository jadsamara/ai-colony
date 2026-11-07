import { randomUUID } from "node:crypto";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { Persistence } from "../ports/repositories.js";
import {
  DEFAULT_EVIDENCE_RETENTION,
  promptSnapshot,
  retainPayload,
  retentionExpiresAt,
  type EvidenceRetentionConfig,
} from "./evidence-retention.js";
import type {
  EvidenceCorrectionRecord,
  InferenceAttemptRecord,
} from "./evidence-repository.js";
import {
  classifyFailure,
  type AcceptanceStatus,
  type EligibilityStatus,
  type FailureClass,
} from "./evidence-taxonomy.js";

export interface CaptureAttemptInput {
  conversationId: string;
  departmentId: string;
  turnId?: string | null;
  modelRegistryId?: string | null;
  modelVersion?: string | null;
  adapterId?: string | null;
  adapterVersion?: string | null;
  inferenceEndpoint: string;
  attemptNumber: number;
  parentAttemptId?: string | null;
  recoveryOfAttemptId?: string | null;
  messages: Array<{ role: string; content: string }>;
  rawOutput: string;
  parsedOutput?: Record<string, unknown> | null;
  validationResult?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs: number;
  acceptanceStatus: AcceptanceStatus;
  diagnostic?: string | null;
  reason?: string | null;
}

export class TrainingEvidenceService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly retention: EvidenceRetentionConfig = DEFAULT_EVIDENCE_RETENTION,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Persist one inference attempt outside the inference call.
   * On write failure, records an auditable capture failure and returns null.
   */
  async captureAttempt(input: CaptureAttemptInput): Promise<InferenceAttemptRecord | null> {
    const prompt = promptSnapshot(input.messages, this.retention.promptMaxChars);
    const raw = retainPayload(input.rawOutput, this.retention.rawMaxChars);
    const failure =
      input.acceptanceStatus === "rejected" || input.acceptanceStatus === "failed"
        ? classifyFailure(input.diagnostic ?? input.validationResult ?? "rejected", input.reason ?? undefined)
        : null;
    try {
      return await this.persistence.repos.evidence.insertAttempt({
        id: randomUUID(),
        conversationId: input.conversationId,
        turnId: input.turnId ?? null,
        departmentId: input.departmentId,
        modelRegistryId: input.modelRegistryId ?? QWEN3_8B_MODEL_ID,
        modelVersion: input.modelVersion ?? null,
        adapterId: input.adapterId ?? null,
        adapterVersion: input.adapterVersion ?? null,
        inferenceEndpoint: input.inferenceEndpoint.slice(0, 240),
        attemptNumber: input.attemptNumber,
        parentAttemptId: input.parentAttemptId ?? null,
        promptHash: prompt.hash,
        promptSnapshot: prompt.content,
        promptTruncated: prompt.truncated,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        latencyMs: Math.max(0, input.latencyMs),
        rawOutput: raw.content,
        rawOutputHash: raw.hash,
        rawTruncated: raw.truncated,
        rawExpired: false,
        parsedOutput: input.parsedOutput ?? null,
        validationResult: input.validationResult ?? input.diagnostic ?? null,
        acceptanceStatus: input.acceptanceStatus,
        failureClass: failure?.failureClass ?? null,
        failureSymptom: failure?.symptom ?? null,
        failureRootCause: failure?.rootCause ?? null,
        failureProvisional: failure?.provisional ?? true,
        classificationSource: failure?.source ?? "runtime",
        classificationConfidence: failure?.confidence ?? "observed",
        classificationEvidence: failure?.evidence ?? null,
        recoveryOfAttemptId: input.recoveryOfAttemptId ?? null,
        trainingEligible: false,
        eligibilityStatus: "not_reviewed",
        captureStatus: "captured",
        captureError: null,
        createdAt: this.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "evidence capture failed";
      try {
        await this.persistence.repos.evidence.insertCaptureFailure({
          id: randomUUID(),
          conversationId: input.conversationId,
          departmentId: input.departmentId,
          attemptNumber: input.attemptNumber,
          error: message.slice(0, 1_000),
          context: {
            acceptanceStatus: input.acceptanceStatus,
            promptHash: prompt.hash,
            rawOutputHash: raw.hash,
            endpoint: input.inferenceEndpoint.slice(0, 120),
          },
          createdAt: this.now().toISOString(),
        });
      } catch {
        // Secondary failure is still surfaced via null return + caller progress flag.
      }
      return null;
    }
  }

  async attachTurn(attemptId: string, turnId: string): Promise<void> {
    await this.persistence.repos.evidence.updateAttempt(attemptId, { turnId });
  }

  async listAttempts(
    ctx: RequestContext,
    filter: {
      conversationId?: string;
      departmentId?: string;
      modelRegistryId?: string;
      failureClass?: FailureClass;
      acceptanceStatus?: AcceptanceStatus;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
      includeRaw?: boolean;
    },
  ) {
    this.authorizer.assert(ctx.actor, "training:evidence:read");
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    const result = await this.persistence.repos.evidence.listAttempts({
      conversationId: filter.conversationId,
      departmentId: filter.departmentId,
      modelRegistryId: filter.modelRegistryId,
      failureClass: filter.failureClass,
      acceptanceStatus: filter.acceptanceStatus,
      since: filter.since ? new Date(filter.since) : undefined,
      until: filter.until ? new Date(filter.until) : undefined,
      limit,
      offset,
    });
    const includeRaw = filter.includeRaw === true && ctx.actor.role === "system_administrator";
    return {
      total: result.total,
      limit,
      offset,
      data: result.rows.map((row) => this.publicAttempt(row, includeRaw)),
    };
  }

  async getAttempt(ctx: RequestContext, id: string, includeRaw = false) {
    this.authorizer.assert(ctx.actor, "training:evidence:read");
    const row = await this.persistence.repos.evidence.findAttempt(id);
    if (!row) {
      throw notFound("InferenceAttempt", id);
    }
    const raw = includeRaw && ctx.actor.role === "system_administrator";
    const corrections = await this.persistence.repos.evidence.listCorrections(id);
    const eligibility = await this.persistence.repos.evidence.listEligibilityEvents(id);
    return {
      attempt: this.publicAttempt(row, raw),
      corrections,
      eligibilityEvents: eligibility,
      provenance: {
        knowledgeSystem: "separate" as const,
        trainingEligible: row.trainingEligible,
        eligibilityStatus: row.eligibilityStatus,
        note: "Training evidence is not department knowledge and is not a training example by default.",
      },
    };
  }

  async failureStats(
    ctx: RequestContext,
    filter: {
      conversationId?: string;
      departmentId?: string;
      modelRegistryId?: string;
      since?: string;
      until?: string;
    },
  ) {
    this.authorizer.assert(ctx.actor, "training:evidence:read");
    const rows = await this.persistence.repos.evidence.failureStats({
      conversationId: filter.conversationId,
      departmentId: filter.departmentId,
      modelRegistryId: filter.modelRegistryId,
      since: filter.since ? new Date(filter.since) : undefined,
      until: filter.until ? new Date(filter.until) : undefined,
    });
    return { data: rows };
  }

  async proposeCorrection(
    ctx: RequestContext,
    input: {
      attemptId: string;
      proposedResponse: string;
      artifactRef?: string | null;
      supportingEvidence?: string | null;
      taskLabel?: string | null;
    },
  ) {
    this.authorizer.assert(ctx.actor, "training:evidence:correct");
    const attempt = await this.persistence.repos.evidence.findAttempt(input.attemptId);
    if (!attempt) {
      throw notFound("InferenceAttempt", input.attemptId);
    }
    const correction: EvidenceCorrectionRecord = {
      id: randomUUID(),
      attemptId: attempt.id,
      proposedResponse: input.proposedResponse.slice(0, 8_000),
      artifactRef: input.artifactRef ?? null,
      authorType: "human",
      authorId: ctx.actor.principalId,
      verificationStatus: "unverified",
      verifierId: null,
      verificationMethod: null,
      supportingEvidence: input.supportingEvidence?.slice(0, 2_000) ?? null,
      departmentId: attempt.departmentId,
      modelRegistryId: attempt.modelRegistryId,
      taskLabel: input.taskLabel ?? null,
      createdAt: this.now().toISOString(),
      reviewedAt: null,
      revision: 1,
    };
    const saved = await this.persistence.repos.evidence.insertCorrection(correction);
    await this.persistence.repos.evidence.insertCorrectionEvent({
      id: randomUUID(),
      correctionId: saved.id,
      eventType: "proposed",
      fromStatus: null,
      toStatus: "unverified",
      actorId: ctx.actor.principalId,
      method: "human_proposal",
      evidence: input.supportingEvidence ?? null,
      snapshot: { ...saved },
      createdAt: this.now().toISOString(),
    });
    await this.audit(ctx, "training.evidence.correction.proposed", "training_evidence_correction", saved.id, {
      attemptId: attempt.id,
    });
    return saved;
  }

  async reviewCorrection(
    ctx: RequestContext,
    correctionId: string,
    input: { decision: "verified" | "rejected"; method: string; evidence?: string | null },
  ) {
    this.authorizer.assert(ctx.actor, "training:evidence:review");
    if (/llm|model.agree|another model|auto/i.test(input.method) && input.decision === "verified") {
      throw new DomainError(
        "VERIFICATION_METHOD_REJECTED",
        "A correction must not be marked verified merely because another LLM agrees with it",
        400,
      );
    }
    const existing = await this.persistence.repos.evidence.findCorrection(correctionId);
    if (!existing) {
      throw notFound("EvidenceCorrection", correctionId);
    }
    if (existing.verificationStatus !== "unverified") {
      throw new DomainError("INVALID_STATE", "Correction already reviewed", 409);
    }
    const updated = await this.persistence.repos.evidence.updateCorrection(correctionId, {
      verificationStatus: input.decision,
      verifierId: ctx.actor.principalId,
      verificationMethod: input.method.slice(0, 200),
      supportingEvidence: input.evidence?.slice(0, 2_000) ?? existing.supportingEvidence,
      reviewedAt: this.now().toISOString(),
      revision: existing.revision + 1,
    });
    await this.persistence.repos.evidence.insertCorrectionEvent({
      id: randomUUID(),
      correctionId,
      eventType: input.decision,
      fromStatus: existing.verificationStatus,
      toStatus: input.decision,
      actorId: ctx.actor.principalId,
      method: input.method,
      evidence: input.evidence ?? null,
      snapshot: { ...updated },
      createdAt: this.now().toISOString(),
    });
    await this.audit(ctx, `training.evidence.correction.${input.decision}`, "training_evidence_correction", correctionId, {
      attemptId: existing.attemptId,
      method: input.method,
    });
    // Verified corrections do not become training examples or flip training_eligible.
    return updated;
  }

  async setEligibility(
    ctx: RequestContext,
    attemptId: string,
    input: { status: EligibilityStatus; reason: string },
  ) {
    this.authorizer.assert(ctx.actor, "training:evidence:eligibility");
    const attempt = await this.persistence.repos.evidence.findAttempt(attemptId);
    if (!attempt) {
      throw notFound("InferenceAttempt", attemptId);
    }
    // C1.6: eligibility status may advance, but conversation evidence never becomes training data.
    const eligibleFlag = false;
    const updated = await this.persistence.repos.evidence.updateAttempt(attemptId, {
      eligibilityStatus: input.status,
      trainingEligible: eligibleFlag,
    });
    await this.persistence.repos.evidence.insertEligibilityEvent({
      id: randomUUID(),
      attemptId,
      fromStatus: attempt.eligibilityStatus,
      toStatus: input.status,
      fromEligible: attempt.trainingEligible,
      toEligible: eligibleFlag,
      actorId: ctx.actor.principalId,
      reason: input.reason.slice(0, 1_000),
      createdAt: this.now().toISOString(),
    });
    await this.audit(ctx, "training.evidence.eligibility.updated", "training_inference_attempt", attemptId, {
      from: attempt.eligibilityStatus,
      to: input.status,
      trainingEligible: eligibleFlag,
    });
    return this.publicAttempt(updated, ctx.actor.role === "system_administrator");
  }

  async expireRaw(ctx: RequestContext, beforeIso?: string) {
    this.authorizer.assert(ctx.actor, "training:evidence:eligibility");
    const before = beforeIso
      ? new Date(beforeIso)
      : retentionExpiresAt(this.now(), -this.retention.retentionDays);
    const cutoff = beforeIso ? before : new Date(this.now().getTime() - this.retention.retentionDays * 86_400_000);
    const count = await this.persistence.repos.evidence.expireRawPayloads(cutoff, 500);
    await this.audit(ctx, "training.evidence.raw.expired", "training_inference_attempt", "batch", { count, cutoff: cutoff.toISOString() });
    return { expired: count, cutoff: cutoff.toISOString() };
  }

  async listCaptureFailures(ctx: RequestContext, limit = 50) {
    this.authorizer.assert(ctx.actor, "training:evidence:read");
    return { data: await this.persistence.repos.evidence.listCaptureFailures(Math.min(limit, 100)) };
  }

  private publicAttempt(row: InferenceAttemptRecord, includeRaw: boolean) {
    const privileged = includeRaw;
    return {
      ...row,
      promptSnapshot: privileged ? row.promptSnapshot : null,
      rawOutput: privileged && !row.rawExpired ? row.rawOutput : null,
      rawAvailable: Boolean(row.rawOutput) && !row.rawExpired,
      promptAvailable: Boolean(row.promptSnapshot),
      trainingEligible: row.trainingEligible,
      datasetIncluded: false as const,
    };
  }

  private async audit(
    ctx: RequestContext,
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.persistence.repos.audit.append({
      eventType: action,
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType,
      targetId,
      action,
      correlationId: ctx.correlationId,
      beforeState: null,
      afterState: details,
      metadata: {},
    });
  }
}
