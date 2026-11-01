export interface BenchmarkSuiteRecord {
  id: string;
  slug: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface BenchmarkVersionRecord {
  id: string;
  suiteId: string;
  version: number;
  description: string;
  domain: string;
  source: string;
  license: string;
  protocol: string;
  scorerId: string;
  scorerVersion: string;
  contentHash: string;
  promptTemplateHash: string;
  decoding: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  status: "draft" | "published" | "retired";
  sealed: boolean;
  createdBy: string;
  approvedBy: string | null;
  createdAt: string;
}

export interface BenchmarkItemRecord {
  id: string;
  versionId: string;
  ordinal: number;
  domain: string;
  prompt: string;
  expected: string;
  promptHash: string;
  sealed: boolean;
}

export interface EvaluationRunRecord {
  id: string;
  benchmarkVersionId: string;
  candidateId: string | null;
  trainableModelId: string | null;
  baseSha256: string;
  adapterSha256: string | null;
  source: "live" | "historical";
  status: "completed" | "failed";
  decoding: Record<string, unknown>;
  createdBy: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface EvaluationResultRecord {
  id: string;
  runId: string;
  ordinal: number;
  role: "baseline" | "candidate";
  rawOutput: string;
  taskCorrect: boolean;
  formatValid: boolean;
  strictIntegerMatch: boolean;
  ambiguous: boolean;
  equationValue: string | null;
}

export interface EvaluationReportRecord {
  id: string;
  runId: string;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface GateRecord {
  id: string;
  candidateId: string;
  reportId: string;
  decision: "PASS" | "FAIL" | "INCONCLUSIVE" | "QUARANTINED";
  rationale: string;
  policyHash: string;
  decidedBy: string;
  createdAt: string;
}

export interface RouteRecord {
  id: string;
  slug: string;
  currentVersion: number | null;
  updatedAt: string;
}

export interface RouteVersionRecord {
  id: string;
  routeId: string;
  version: number;
  kind: "baseline" | "candidate";
  candidateId: string | null;
  trainableModelId: string;
  adapterSha256: string | null;
  baseSha256: string;
  createdBy: string;
  createdAt: string;
}

export interface RollbackRecord {
  id: string;
  routeId: string;
  fromVersion: number;
  toVersion: number;
  status: "requested" | "approved" | "completed" | "failed";
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  error: string | null;
  verification: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ForgettingRecord {
  id: string;
  memoryId: string;
  status: "requested" | "approved" | "completed" | "rejected" | "failed";
  idempotencyKey: string;
  impact: Record<string, unknown>;
  requestedBy: string;
  approvedBy: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface MemoryImpact {
  revisionCount: number;
  embeddingPresent: boolean;
  derivedMemoryIds: string[];
  promotionCopyIds: string[];
  exampleIds: string[];
  datasetVersionIds: string[];
  artifactIds: string[];
  relation: "definitely_used" | "not_used";
}

export interface SafeguardSummary {
  failedRuns: number;
  gateFailures: number;
  quarantined: number;
  contaminatedArtifacts: number;
  forgettingOpen: number;
  rollbackFailures: number;
}

export interface EvaluationRepository {
  insertSuite(input: BenchmarkSuiteRecord): Promise<void>;
  listSuites(): Promise<BenchmarkSuiteRecord[]>;
  findSuite(id: string): Promise<BenchmarkSuiteRecord | null>;
  findSuiteBySlug(slug: string): Promise<BenchmarkSuiteRecord | null>;
  insertVersion(input: BenchmarkVersionRecord): Promise<void>;
  findVersion(id: string): Promise<BenchmarkVersionRecord | null>;
  listVersions(suiteId: string): Promise<BenchmarkVersionRecord[]>;
  publishVersion(id: string, approvedBy: string): Promise<void>;
  insertItems(items: BenchmarkItemRecord[]): Promise<void>;
  listItems(versionId: string): Promise<BenchmarkItemRecord[]>;
  sealedPromptHashes(): Promise<string[]>;
  insertRun(input: EvaluationRunRecord): Promise<void>;
  findRun(id: string): Promise<EvaluationRunRecord | null>;
  insertResults(rows: EvaluationResultRecord[]): Promise<void>;
  listResults(runId: string): Promise<EvaluationResultRecord[]>;
  insertReport(input: EvaluationReportRecord): Promise<void>;
  findReportByRun(runId: string): Promise<EvaluationReportRecord | null>;
  insertGate(input: GateRecord): Promise<void>;
  listGates(candidateId: string): Promise<GateRecord[]>;
  insertRoute(input: RouteRecord): Promise<void>;
  findRoute(id: string): Promise<RouteRecord | null>;
  findRouteBySlug(slug: string): Promise<RouteRecord | null>;
  listRoutes(): Promise<RouteRecord[]>;
  setRouteVersion(id: string, version: number | null, at: string): Promise<void>;
  insertRouteVersion(input: RouteVersionRecord): Promise<void>;
  listRouteVersions(routeId: string): Promise<RouteVersionRecord[]>;
  findRouteVersion(routeId: string, version: number): Promise<RouteVersionRecord | null>;
  insertRollback(input: RollbackRecord): Promise<void>;
  findRollback(id: string): Promise<RollbackRecord | null>;
  updateRollback(id: string, patch: Partial<Pick<RollbackRecord, "status" | "approvedBy" | "error" | "verification" | "finishedAt">>): Promise<void>;
  insertRetention(input: { id: string; name: string; version: number; scope: string | null; provenance: string | null; maxAgeDays: number | null; createdBy: string; createdAt: string }): Promise<void>;
  listRetention(): Promise<Array<{ id: string; name: string; version: number; scope: string | null; provenance: string | null; maxAgeDays: number | null; status: string; createdBy: string; createdAt: string }>>;
  insertForgetting(input: ForgettingRecord): Promise<void>;
  findForgetting(id: string): Promise<ForgettingRecord | null>;
  findForgettingByKey(key: string): Promise<ForgettingRecord | null>;
  updateForgetting(id: string, patch: Partial<Pick<ForgettingRecord, "status" | "approvedBy" | "impact" | "error" | "finishedAt">>): Promise<void>;
  memoryImpact(memoryId: string): Promise<MemoryImpact>;
  insertLineage(input: { id: string; fromType: string; fromId: string; toType: string; toId: string; relation: string; createdAt: string }): Promise<void>;
  contaminate(input: { id: string; artifactId: string; forgettingRequestId: string; relation: string; createdAt: string }): Promise<void>;
  isArtifactContaminated(artifactId: string): Promise<boolean>;
  summary(): Promise<SafeguardSummary>;
}
