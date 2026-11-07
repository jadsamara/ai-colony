import type {
  AcceptanceStatus,
  ClassificationConfidence,
  ClassificationSource,
  CorrectionStatus,
  EligibilityStatus,
  FailureClass,
} from "./evidence-taxonomy.js";

export interface InferenceAttemptRecord {
  id: string;
  conversationId: string;
  turnId: string | null;
  departmentId: string;
  modelRegistryId: string | null;
  modelVersion: string | null;
  adapterId: string | null;
  adapterVersion: string | null;
  inferenceEndpoint: string;
  attemptNumber: number;
  parentAttemptId: string | null;
  createdAt: string;
  promptHash: string;
  promptSnapshot: string | null;
  promptTruncated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  rawOutput: string | null;
  rawOutputHash: string;
  rawTruncated: boolean;
  rawExpired: boolean;
  parsedOutput: Record<string, unknown> | null;
  validationResult: string | null;
  acceptanceStatus: AcceptanceStatus;
  failureClass: FailureClass | null;
  failureSymptom: string | null;
  failureRootCause: string | null;
  failureProvisional: boolean;
  classificationSource: ClassificationSource;
  classificationConfidence: ClassificationConfidence;
  classificationEvidence: string | null;
  recoveryOfAttemptId: string | null;
  trainingEligible: boolean;
  eligibilityStatus: EligibilityStatus;
  captureStatus: "captured" | "capture_failed" | "unavailable";
  captureError: string | null;
}

export interface EvidenceCorrectionRecord {
  id: string;
  attemptId: string;
  proposedResponse: string;
  artifactRef: string | null;
  authorType: "human" | "evaluation" | "system";
  authorId: string;
  verificationStatus: CorrectionStatus;
  verifierId: string | null;
  verificationMethod: string | null;
  supportingEvidence: string | null;
  departmentId: string | null;
  modelRegistryId: string | null;
  taskLabel: string | null;
  createdAt: string;
  reviewedAt: string | null;
  revision: number;
}

export interface EvidenceCorrectionEventRecord {
  id: string;
  correctionId: string;
  eventType: "proposed" | "verified" | "rejected" | "revised";
  fromStatus: string | null;
  toStatus: string | null;
  actorId: string;
  method: string | null;
  evidence: string | null;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export interface EvidenceEligibilityEventRecord {
  id: string;
  attemptId: string;
  fromStatus: string;
  toStatus: string;
  fromEligible: boolean;
  toEligible: boolean;
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface EvidenceCaptureFailureRecord {
  id: string;
  conversationId: string | null;
  departmentId: string | null;
  attemptNumber: number | null;
  error: string;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface AttemptInsert extends Omit<InferenceAttemptRecord, "createdAt"> {
  createdAt?: Date;
}

export interface AttemptListFilter {
  conversationId?: string;
  departmentId?: string;
  modelRegistryId?: string;
  failureClass?: FailureClass;
  acceptanceStatus?: AcceptanceStatus;
  since?: Date;
  until?: Date;
  limit: number;
  offset: number;
}

export interface FailureStatsRow {
  failureClass: string | null;
  acceptanceStatus: string;
  count: number;
}

export interface TrainingEvidenceRepository {
  insertAttempt(row: AttemptInsert): Promise<InferenceAttemptRecord>;
  updateAttempt(
    id: string,
    patch: Partial<
      Pick<
        InferenceAttemptRecord,
        | "turnId"
        | "acceptanceStatus"
        | "parsedOutput"
        | "validationResult"
        | "failureClass"
        | "failureSymptom"
        | "failureRootCause"
        | "failureProvisional"
        | "classificationSource"
        | "classificationConfidence"
        | "classificationEvidence"
        | "recoveryOfAttemptId"
        | "trainingEligible"
        | "eligibilityStatus"
        | "rawOutput"
        | "rawExpired"
        | "promptSnapshot"
      >
    >,
  ): Promise<InferenceAttemptRecord>;
  findAttempt(id: string): Promise<InferenceAttemptRecord | null>;
  listAttempts(filter: AttemptListFilter): Promise<{ rows: InferenceAttemptRecord[]; total: number }>;
  failureStats(filter: Omit<AttemptListFilter, "limit" | "offset">): Promise<FailureStatsRow[]>;
  insertCorrection(row: EvidenceCorrectionRecord): Promise<EvidenceCorrectionRecord>;
  updateCorrection(
    id: string,
    patch: Partial<
      Pick<
        EvidenceCorrectionRecord,
        "verificationStatus" | "verifierId" | "verificationMethod" | "supportingEvidence" | "reviewedAt" | "revision" | "proposedResponse"
      >
    >,
  ): Promise<EvidenceCorrectionRecord>;
  findCorrection(id: string): Promise<EvidenceCorrectionRecord | null>;
  listCorrections(attemptId: string): Promise<EvidenceCorrectionRecord[]>;
  insertCorrectionEvent(row: EvidenceCorrectionEventRecord): Promise<void>;
  listCorrectionEvents(correctionId: string): Promise<EvidenceCorrectionEventRecord[]>;
  insertEligibilityEvent(row: EvidenceEligibilityEventRecord): Promise<void>;
  listEligibilityEvents(attemptId: string): Promise<EvidenceEligibilityEventRecord[]>;
  insertCaptureFailure(row: EvidenceCaptureFailureRecord): Promise<void>;
  listCaptureFailures(limit: number): Promise<EvidenceCaptureFailureRecord[]>;
  expireRawPayloads(before: Date, limit: number): Promise<number>;
}
