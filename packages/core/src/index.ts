export { DomainError, notFound } from "./errors/domain-error.js";
export { snapshot, type RequestContext } from "./context.js";
export { buildPage, decodeCursor, encodeCursor, type DecodedCursor } from "./pagination.js";
export {
  assertAgentBudgetWithinDepartment,
  assertDepartmentBudgetCoversAgents,
  assertParameterBudgetMatchesCompute,
  BUDGET_ENFORCEMENT_SCOPE,
  parseParameterBudget,
  parseResourceBudget,
} from "./budgets/budget.js";
export { assertNoHierarchyCycle } from "./departments/hierarchy.js";
export {
  assertDepartmentTransition,
  canTransitionDepartment,
  DEPARTMENT_TRANSITIONS,
  isPermanentDepartmentType,
} from "./departments/transitions.js";
export { DepartmentService } from "./departments/department-service.js";
export {
  AGENT_TRANSITIONS,
  assertAgentTransition,
  canTransitionAgent,
  isTransitionalStatus,
  recoveryStatus,
} from "./agents/lifecycle.js";
export { AgentService } from "./agents/agent-service.js";
export { Authorizer } from "./governance/authorizer.js";
export { ApprovalService, type ApprovalResult } from "./governance/approval-service.js";
export { IdentityService } from "./governance/identity-service.js";
export {
  assertCanAssignRole,
  assertCanCreateAgentWithRole,
  assertCanCreateDepartment,
  assertCanDecideApproval,
  assertNotSelfBudgetChange,
} from "./governance/self-protection.js";
export {
  isRoleName,
  listRoleGrants,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  permissionsForRole,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  type Permission,
} from "./governance/permissions.js";
export { AuditQueryService } from "./audit/audit-query-service.js";
export { ModelService } from "./models/model-service.js";
export { TrainingService } from "./training/training-service.js";
export { ExperimentService } from "./training/experiment-service.js";
export { TRAINING_METHODS, assertMethodExecutable, assertSafeConfig, isHighRisk, planExperiments, selectDevelopmentCandidate } from "./training/experiment-planner.js";
export { meanExposures, outputDisagreement, stopDecision } from "./training/stability.js";
export { EvaluationService } from "./evaluation/evaluation-service.js";
export { DepartmentLearningService } from "./learning/learning-service.js";
export { CollaborationService } from "./learning/collaboration-service.js";
export { promotionAllowed, retainedProvenance } from "./learning/collaboration-policy.js";
export { assertLearningTransition, gapFingerprint, selectLearningMethod, outcomeForMethod, weightImprovementVerified, LEARNING_CYCLE_STATUSES } from "./learning/transitions.js";
export type {
  AssignmentRecord,
  BudgetRecord,
  CapabilityRecord,
  CapabilityVersionRecord,
  GapRecord,
  LearningCycleRecord,
  LearningEventRecord,
  LearningObjectiveRecord,
  LearningRepository,
  OutcomeRecord,
  TransferRecord,
  ValidationRecord,
  ImprovementDecisionRecord,
  DeploymentDecisionRecord,
  CollaborationContextRecord,
  CollaborationParticipantRecord,
  CollaborationEntryRecord,
  MemoryOwnershipRecord,
} from "./learning/repository.js";
export type {
  BenchmarkItemRecord,
  BenchmarkSuiteRecord,
  BenchmarkVersionRecord,
  EvaluationRepository,
  EvaluationResultRecord,
  EvaluationRunRecord,
  ForgettingRecord,
  GateRecord,
  RollbackRecord,
  RouteRecord,
  RouteVersionRecord,
} from "./evaluation/repository.js";
export { gradeArithmetic } from "./evaluation/score.js";
export { claimSignificance, mcnemarExact, pairedCounts, wilsonInterval } from "./evaluation/stats.js";
export { applyGateIfComparable, decideGate, GATE_POLICY, gatePolicyHash } from "./evaluation/gate.js";
export { compareManifests } from "./evaluation/compare.js";
export { classifyItem, summarizeItems } from "./evaluation/classify.js";
export {
  configurationFingerprint,
  contentDigest,
  EVALUATION_CONTRACT_VERSION,
  itemSetFingerprint,
  parseEvaluationManifest,
  type EvaluationManifest,
} from "./evaluation/manifest.js";
export { colonyRunContract, legacyManifest } from "./evaluation/colony-manifest.js";
export { analyzePairedRuns } from "./evaluation/paired.js";
export { CapabilityLedgerService, separateModelIdentity } from "./capability/service.js";
export { MemoryCapabilityRepository, type CapabilityRepository } from "./capability/repository.js";
export { holmAdjust, applyHolm } from "./capability/holm.js";
export { pairedScoreInterval } from "./capability/interval.js";
export { validateTaxonomyGraph, reconstructTaxonomy } from "./capability/taxonomy.js";
export { compareCertifiedSnapshots } from "./capability/compare.js";
export { SNAPSHOT_SCHEMA_VERSION } from "./capability/types.js";
export type {
  LedgerDecision,
  LedgerEdge,
  LedgerMapping,
  LedgerMappingVersion,
  LedgerProposal,
  LedgerRetentionEvent,
  LedgerSnapshot,
  LedgerTaxonomyVersion,
  LedgerTopic,
  LedgerTopicEvent,
  ModelIdentitySeparation,
  TaxonomyNode,
} from "./capability/types.js";
export { assessDeployment, improvementPolicyHash, verifyImprovement, IMPROVEMENT_POLICY } from "./evaluation/improvement.js";
export type { DeploymentEligibility, ImprovementClass, ImprovementEvidence, ImprovementVerdict } from "./evaluation/improvement.js";
export { ScriptedTrainingProvider, type ScriptedTrainingOptions } from "./training/scripted-provider.js";
export { MlxTrainingProvider } from "./training/mlx-provider.js";
export { ACCEPTANCE_CRITERIA, applyReserved, assignSplit, buildCuratedArithmetic, exampleFromMemory, examplesFromSupplied, parseArithmetic } from "./training/dataset.js";
export { meetsAcceptance, scoreOutputs } from "./training/evaluate.js";
export { frozenConfig, TRAINING_BUDGETS } from "./training/profiles.js";
export { assertNotSelfDecision, assertTrainingTransition } from "./training/transitions.js";
export { assertInsideRoot, trainingScript } from "./training/paths.js";
export type { TrainingProvider } from "./training/provider.js";
export type {
  AdapterRecord,
  ArtifactRecord,
  CandidateRecord,
  DatasetVersionRecord,
  EvaluationRecord,
  ExampleRecord,
  TrainableRecord,
  TrainingRepository,
  TrainingRunRecord,
  TrainingSummary,
} from "./training/repository.js";
export { AgentRuntime } from "./runtime/agent-runtime.js";
export { LifecycleOnlyExecutor } from "./runtime/lifecycle-only-executor.js";
export { assembleAgentStatus, type AgentExecutor, type RuntimeSession } from "./runtime/status.js";
export { isStaleRuntime } from "./runtime/stale.js";
export {
  artifactPresence,
  describeModelHealth,
  inferenceReadiness,
  ollamaManifestPath,
  type ModelObservation,
  type PersistedRuntimeStatus,
} from "./runtime/model-health.js";
export {
  assessApi,
  assessDispatcher,
  assessPostgres,
  assessRegistry,
  assessTraining,
  assessWorkers,
  buildRuntimeReport,
  type ComponentHealth,
} from "./runtime/colony-health.js";
export {
  API_PROCESS,
  DISPATCHER_PROCESS,
  TRAINING_PROCESS,
  WORKER_PROCESS,
  commandLines,
  processSeen,
  tcpReachable,
} from "./runtime/local-signals.js";
export { summarizeOutbox, type OutboxObservation, type OutboxSummary } from "./messaging/outbox-summary.js";
export type { InferenceWorkerPort, TrainingWorkerPort } from "./runtime/worker-ports.js";
export {
  assertRecipientAgentEligible,
  assertRecipientDepartmentEligible,
  assertSenderEligible,
  canDecideMessage,
  canReadMessage,
  crossDepartmentDeliveryAllowed,
} from "./messaging/access.js";
export { messageIdentityHash } from "./messaging/hash.js";
export { MessageHandlingError, recordReceipt, type MessageHandler } from "./messaging/handlers.js";
export { MessagingService, type DeliveryOutcome, type SendResult } from "./messaging/message-service.js";
export { InferenceError, type InferenceProvider, type InferenceRequest, type InferenceResult, type ModelProbe } from "./inference/provider.js";
export { estimateCostUsdMicros, estimateTokens, normalizeUsage, type CostRates, type TokenUsage } from "./inference/usage.js";
export {
  ObjectiveService,
  DEFAULT_OBJECTIVE_LIMITS,
  type InferenceRoute,
  type ObjectiveMemory,
  type PreparedGeneration,
} from "./objectives/objective-service.js";
export { validatePlan, extractJsonObject, planErrors, type PlanContext } from "./objectives/plan.js";
export { chooseDispatch, readyTaskIds, blockedTaskIds } from "./objectives/schedule.js";
export { assertObjectiveTransition, assertTaskTransition } from "./objectives/transitions.js";
export { canReadMemory, nextScope } from "./memory/access.js";
export {
  assertFiniteVector,
  cosineSimilarity,
  deterministicEmbedding,
  EmbeddingError,
  type EmbeddingProvider,
  type EmbeddingVector,
} from "./memory/embedding.js";
export { DEFAULT_MEMORY_LIMITS, MemoryService, type MemoryLimits } from "./memory/memory-service.js";
export { fitContext, rankMemories } from "./memory/rank.js";
export { planPrompt, renderMemoryBlock, withMemory } from "./objectives/prompts.js";
export {
  DEAD_EXCHANGE,
  DEAD_QUEUE,
  DEFAULT_MESSAGING_POLICY,
  departmentQueueName,
  MESSAGES_EXCHANGE,
  retryDelayMs,
  routingKeyFor,
  type MessagingPolicy,
} from "./messaging/policy.js";
export type {
  AgentBudgetRow,
  AgentListFilter,
  AgentPatch,
  AgentRepository,
  ApprovalListFilter,
  ApprovalRepository,
  AuditListFilter,
  AuditRepository,
  DepartmentListFilter,
  DepartmentPatch,
  DepartmentRepository,
  LifecycleRepository,
  MessageListFilter,
  EligibleAgent,
  InferenceRow,
  MessageRepository,
  MessageVisibility,
  MemoryPromotionRow,
  MemoryRepository,
  MemoryRevisionRow,
  MemoryRow,
  MemorySearchRow,
  MemorySourceRow,
  MemoryVisibility,
  ObjectiveRepository,
  ObjectiveRun,
  ObjectiveTaskRecord,
  ModelListFilter,
  ModelRepository,
  NewAgent,
  NewApproval,
  NewAuditEvent,
  NewDepartment,
  NewLifecycleEvent,
  NewMessageRecord,
  NewModel,
  NewPrincipal,
  OutboxRow,
  Page,
  PageQuery,
  ProcessingRow,
  ProcessingStatus,
  Persistence,
  ExperimentRepository,
  StoredExperiment,
  PrincipalRecord,
  PrincipalRepository,
  StoredMessage,
  Repositories,
} from "./ports/repositories.js";
