import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import type {
  AttemptListFilter,
  EvidenceCaptureFailureRecord,
  EvidenceCorrectionEventRecord,
  EvidenceCorrectionRecord,
  EvidenceEligibilityEventRecord,
  InferenceAttemptRecord,
  TrainingEvidenceRepository,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import {
  trainingEvidenceCaptureFailures,
  trainingEvidenceCorrectionEvents,
  trainingEvidenceCorrections,
  trainingEvidenceEligibilityEvents,
  trainingInferenceAttempts,
} from "../schema/index.js";

export function createEvidenceRepository(db: DbExecutor): TrainingEvidenceRepository {
  return {
    async insertAttempt(row) {
      return guard(async () => {
        const [saved] = await db
          .insert(trainingInferenceAttempts)
          .values({
            id: row.id,
            conversationId: row.conversationId,
            turnId: row.turnId,
            departmentId: row.departmentId,
            modelRegistryId: row.modelRegistryId,
            modelVersion: row.modelVersion,
            adapterId: row.adapterId,
            adapterVersion: row.adapterVersion,
            inferenceEndpoint: row.inferenceEndpoint,
            attemptNumber: row.attemptNumber,
            parentAttemptId: row.parentAttemptId,
            createdAt: row.createdAt ?? new Date(),
            promptHash: row.promptHash,
            promptSnapshot: row.promptSnapshot,
            promptTruncated: row.promptTruncated,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            latencyMs: row.latencyMs,
            rawOutput: row.rawOutput,
            rawOutputHash: row.rawOutputHash,
            rawTruncated: row.rawTruncated,
            rawExpired: row.rawExpired,
            parsedOutput: row.parsedOutput,
            validationResult: row.validationResult,
            acceptanceStatus: row.acceptanceStatus,
            failureClass: row.failureClass,
            failureSymptom: row.failureSymptom,
            failureRootCause: row.failureRootCause,
            failureProvisional: row.failureProvisional,
            classificationSource: row.classificationSource,
            classificationConfidence: row.classificationConfidence,
            classificationEvidence: row.classificationEvidence,
            recoveryOfAttemptId: row.recoveryOfAttemptId,
            trainingEligible: row.trainingEligible,
            eligibilityStatus: row.eligibilityStatus,
            captureStatus: row.captureStatus,
            captureError: row.captureError,
          })
          .returning();
        if (!saved) {
          throw new Error("training_inference_attempts insert returned no row");
        }
        return mapAttempt(saved);
      });
    },

    async updateAttempt(id, patch) {
      return guard(async () => {
        const [saved] = await db
          .update(trainingInferenceAttempts)
          .set({
            ...(patch.turnId !== undefined ? { turnId: patch.turnId } : {}),
            ...(patch.acceptanceStatus !== undefined ? { acceptanceStatus: patch.acceptanceStatus } : {}),
            ...(patch.parsedOutput !== undefined ? { parsedOutput: patch.parsedOutput } : {}),
            ...(patch.validationResult !== undefined ? { validationResult: patch.validationResult } : {}),
            ...(patch.failureClass !== undefined ? { failureClass: patch.failureClass } : {}),
            ...(patch.failureSymptom !== undefined ? { failureSymptom: patch.failureSymptom } : {}),
            ...(patch.failureRootCause !== undefined ? { failureRootCause: patch.failureRootCause } : {}),
            ...(patch.failureProvisional !== undefined ? { failureProvisional: patch.failureProvisional } : {}),
            ...(patch.classificationSource !== undefined ? { classificationSource: patch.classificationSource } : {}),
            ...(patch.classificationConfidence !== undefined
              ? { classificationConfidence: patch.classificationConfidence }
              : {}),
            ...(patch.classificationEvidence !== undefined
              ? { classificationEvidence: patch.classificationEvidence }
              : {}),
            ...(patch.recoveryOfAttemptId !== undefined ? { recoveryOfAttemptId: patch.recoveryOfAttemptId } : {}),
            ...(patch.trainingEligible !== undefined ? { trainingEligible: patch.trainingEligible } : {}),
            ...(patch.eligibilityStatus !== undefined ? { eligibilityStatus: patch.eligibilityStatus } : {}),
            ...(patch.rawOutput !== undefined ? { rawOutput: patch.rawOutput } : {}),
            ...(patch.rawExpired !== undefined ? { rawExpired: patch.rawExpired } : {}),
            ...(patch.promptSnapshot !== undefined ? { promptSnapshot: patch.promptSnapshot } : {}),
          })
          .where(eq(trainingInferenceAttempts.id, id))
          .returning();
        if (!saved) {
          throw new Error(`training_inference_attempts ${id} not found`);
        }
        return mapAttempt(saved);
      });
    },

    async findAttempt(id) {
      return guard(async () => {
        const [row] = await db.select().from(trainingInferenceAttempts).where(eq(trainingInferenceAttempts.id, id)).limit(1);
        return row ? mapAttempt(row) : null;
      });
    },

    async listAttempts(filter: AttemptListFilter) {
      return guard(async () => {
        const where = attemptWhere(filter);
        const rows = await db
          .select()
          .from(trainingInferenceAttempts)
          .where(where)
          .orderBy(desc(trainingInferenceAttempts.createdAt), desc(trainingInferenceAttempts.id))
          .limit(filter.limit)
          .offset(filter.offset);
        const [totalRow] = await db.select({ value: count() }).from(trainingInferenceAttempts).where(where);
        return { rows: rows.map(mapAttempt), total: Number(totalRow?.value ?? 0) };
      });
    },

    async failureStats(filter) {
      return guard(async () => {
        const where = attemptWhere({ ...filter, limit: 0, offset: 0 });
        const rows = await db
          .select({
            failureClass: trainingInferenceAttempts.failureClass,
            acceptanceStatus: trainingInferenceAttempts.acceptanceStatus,
            count: count(),
          })
          .from(trainingInferenceAttempts)
          .where(where)
          .groupBy(trainingInferenceAttempts.failureClass, trainingInferenceAttempts.acceptanceStatus)
          .orderBy(asc(trainingInferenceAttempts.failureClass));
        return rows.map((row) => ({
          failureClass: row.failureClass,
          acceptanceStatus: row.acceptanceStatus,
          count: Number(row.count),
        }));
      });
    },

    async insertCorrection(row) {
      return guard(async () => {
        const [saved] = await db
          .insert(trainingEvidenceCorrections)
          .values({
            id: row.id,
            attemptId: row.attemptId,
            proposedResponse: row.proposedResponse,
            artifactRef: row.artifactRef,
            authorType: row.authorType,
            authorId: row.authorId,
            verificationStatus: row.verificationStatus,
            verifierId: row.verifierId,
            verificationMethod: row.verificationMethod,
            supportingEvidence: row.supportingEvidence,
            departmentId: row.departmentId,
            modelRegistryId: row.modelRegistryId,
            taskLabel: row.taskLabel,
            createdAt: new Date(row.createdAt),
            reviewedAt: row.reviewedAt ? new Date(row.reviewedAt) : null,
            revision: row.revision,
          })
          .returning();
        if (!saved) {
          throw new Error("training_evidence_corrections insert returned no row");
        }
        return mapCorrection(saved);
      });
    },

    async updateCorrection(id, patch) {
      return guard(async () => {
        const [saved] = await db
          .update(trainingEvidenceCorrections)
          .set({
            ...(patch.verificationStatus !== undefined ? { verificationStatus: patch.verificationStatus } : {}),
            ...(patch.verifierId !== undefined ? { verifierId: patch.verifierId } : {}),
            ...(patch.verificationMethod !== undefined ? { verificationMethod: patch.verificationMethod } : {}),
            ...(patch.supportingEvidence !== undefined ? { supportingEvidence: patch.supportingEvidence } : {}),
            ...(patch.reviewedAt !== undefined ? { reviewedAt: patch.reviewedAt ? new Date(patch.reviewedAt) : null } : {}),
            ...(patch.revision !== undefined ? { revision: patch.revision } : {}),
            ...(patch.proposedResponse !== undefined ? { proposedResponse: patch.proposedResponse } : {}),
          })
          .where(eq(trainingEvidenceCorrections.id, id))
          .returning();
        if (!saved) {
          throw new Error(`training_evidence_corrections ${id} not found`);
        }
        return mapCorrection(saved);
      });
    },

    async findCorrection(id) {
      return guard(async () => {
        const [row] = await db.select().from(trainingEvidenceCorrections).where(eq(trainingEvidenceCorrections.id, id)).limit(1);
        return row ? mapCorrection(row) : null;
      });
    },

    async listCorrections(attemptId) {
      return guard(async () => {
        const rows = await db
          .select()
          .from(trainingEvidenceCorrections)
          .where(eq(trainingEvidenceCorrections.attemptId, attemptId))
          .orderBy(desc(trainingEvidenceCorrections.createdAt));
        return rows.map(mapCorrection);
      });
    },

    async insertCorrectionEvent(row) {
      return guard(async () => {
        await db.insert(trainingEvidenceCorrectionEvents).values({
          id: row.id,
          correctionId: row.correctionId,
          eventType: row.eventType,
          fromStatus: row.fromStatus,
          toStatus: row.toStatus,
          actorId: row.actorId,
          method: row.method,
          evidence: row.evidence,
          snapshot: row.snapshot,
          createdAt: new Date(row.createdAt),
        });
      });
    },

    async listCorrectionEvents(correctionId) {
      return guard(async () => {
        const rows = await db
          .select()
          .from(trainingEvidenceCorrectionEvents)
          .where(eq(trainingEvidenceCorrectionEvents.correctionId, correctionId))
          .orderBy(asc(trainingEvidenceCorrectionEvents.createdAt));
        return rows.map(mapCorrectionEvent);
      });
    },

    async insertEligibilityEvent(row) {
      return guard(async () => {
        await db.insert(trainingEvidenceEligibilityEvents).values({
          id: row.id,
          attemptId: row.attemptId,
          fromStatus: row.fromStatus,
          toStatus: row.toStatus,
          fromEligible: row.fromEligible,
          toEligible: row.toEligible,
          actorId: row.actorId,
          reason: row.reason,
          createdAt: new Date(row.createdAt),
        });
      });
    },

    async listEligibilityEvents(attemptId) {
      return guard(async () => {
        const rows = await db
          .select()
          .from(trainingEvidenceEligibilityEvents)
          .where(eq(trainingEvidenceEligibilityEvents.attemptId, attemptId))
          .orderBy(asc(trainingEvidenceEligibilityEvents.createdAt));
        return rows.map(mapEligibilityEvent);
      });
    },

    async insertCaptureFailure(row) {
      return guard(async () => {
        await db.insert(trainingEvidenceCaptureFailures).values({
          id: row.id,
          conversationId: row.conversationId,
          departmentId: row.departmentId,
          attemptNumber: row.attemptNumber,
          error: row.error,
          context: row.context,
          createdAt: new Date(row.createdAt),
        });
      });
    },

    async listCaptureFailures(limit) {
      return guard(async () => {
        const rows = await db
          .select()
          .from(trainingEvidenceCaptureFailures)
          .orderBy(desc(trainingEvidenceCaptureFailures.createdAt))
          .limit(limit);
        return rows.map(mapCaptureFailure);
      });
    },

    async expireRawPayloads(before, limit) {
      return guard(async () => {
        const expired = await db
          .update(trainingInferenceAttempts)
          .set({
            rawOutput: null,
            promptSnapshot: null,
            rawExpired: true,
          })
          .where(
            and(
              lte(trainingInferenceAttempts.createdAt, before),
              eq(trainingInferenceAttempts.rawExpired, false),
              sql`(${trainingInferenceAttempts.rawOutput} is not null or ${trainingInferenceAttempts.promptSnapshot} is not null)`,
            ),
          )
          .returning({ id: trainingInferenceAttempts.id });
        return Math.min(expired.length, limit);
      });
    },
  };
}

function attemptWhere(filter: AttemptListFilter) {
  const parts = [];
  if (filter.conversationId) {
    parts.push(eq(trainingInferenceAttempts.conversationId, filter.conversationId));
  }
  if (filter.departmentId) {
    parts.push(eq(trainingInferenceAttempts.departmentId, filter.departmentId));
  }
  if (filter.modelRegistryId) {
    parts.push(eq(trainingInferenceAttempts.modelRegistryId, filter.modelRegistryId));
  }
  if (filter.failureClass) {
    parts.push(eq(trainingInferenceAttempts.failureClass, filter.failureClass));
  }
  if (filter.acceptanceStatus) {
    parts.push(eq(trainingInferenceAttempts.acceptanceStatus, filter.acceptanceStatus));
  }
  if (filter.since) {
    parts.push(gte(trainingInferenceAttempts.createdAt, filter.since));
  }
  if (filter.until) {
    parts.push(lte(trainingInferenceAttempts.createdAt, filter.until));
  }
  return parts.length ? and(...parts) : undefined;
}

function mapAttempt(row: typeof trainingInferenceAttempts.$inferSelect): InferenceAttemptRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    turnId: row.turnId,
    departmentId: row.departmentId,
    modelRegistryId: row.modelRegistryId,
    modelVersion: row.modelVersion,
    adapterId: row.adapterId,
    adapterVersion: row.adapterVersion,
    inferenceEndpoint: row.inferenceEndpoint,
    attemptNumber: row.attemptNumber,
    parentAttemptId: row.parentAttemptId,
    createdAt: row.createdAt.toISOString(),
    promptHash: row.promptHash,
    promptSnapshot: row.promptSnapshot,
    promptTruncated: row.promptTruncated,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    rawOutput: row.rawOutput,
    rawOutputHash: row.rawOutputHash,
    rawTruncated: row.rawTruncated,
    rawExpired: row.rawExpired,
    parsedOutput: (row.parsedOutput as Record<string, unknown> | null) ?? null,
    validationResult: row.validationResult,
    acceptanceStatus: row.acceptanceStatus as InferenceAttemptRecord["acceptanceStatus"],
    failureClass: row.failureClass as InferenceAttemptRecord["failureClass"],
    failureSymptom: row.failureSymptom,
    failureRootCause: row.failureRootCause,
    failureProvisional: row.failureProvisional,
    classificationSource: row.classificationSource as InferenceAttemptRecord["classificationSource"],
    classificationConfidence: row.classificationConfidence as InferenceAttemptRecord["classificationConfidence"],
    classificationEvidence: row.classificationEvidence,
    recoveryOfAttemptId: row.recoveryOfAttemptId,
    trainingEligible: row.trainingEligible,
    eligibilityStatus: row.eligibilityStatus as InferenceAttemptRecord["eligibilityStatus"],
    captureStatus: row.captureStatus as InferenceAttemptRecord["captureStatus"],
    captureError: row.captureError,
  };
}

function mapCorrection(row: typeof trainingEvidenceCorrections.$inferSelect): EvidenceCorrectionRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    proposedResponse: row.proposedResponse,
    artifactRef: row.artifactRef,
    authorType: row.authorType as EvidenceCorrectionRecord["authorType"],
    authorId: row.authorId,
    verificationStatus: row.verificationStatus as EvidenceCorrectionRecord["verificationStatus"],
    verifierId: row.verifierId,
    verificationMethod: row.verificationMethod,
    supportingEvidence: row.supportingEvidence,
    departmentId: row.departmentId,
    modelRegistryId: row.modelRegistryId,
    taskLabel: row.taskLabel,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    revision: row.revision,
  };
}

function mapCorrectionEvent(row: typeof trainingEvidenceCorrectionEvents.$inferSelect): EvidenceCorrectionEventRecord {
  return {
    id: row.id,
    correctionId: row.correctionId,
    eventType: row.eventType as EvidenceCorrectionEventRecord["eventType"],
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actorId: row.actorId,
    method: row.method,
    evidence: row.evidence,
    snapshot: row.snapshot as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapEligibilityEvent(row: typeof trainingEvidenceEligibilityEvents.$inferSelect): EvidenceEligibilityEventRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    fromEligible: row.fromEligible,
    toEligible: row.toEligible,
    actorId: row.actorId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapCaptureFailure(row: typeof trainingEvidenceCaptureFailures.$inferSelect): EvidenceCaptureFailureRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    departmentId: row.departmentId,
    attemptNumber: row.attemptNumber,
    error: row.error,
    context: row.context as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}
