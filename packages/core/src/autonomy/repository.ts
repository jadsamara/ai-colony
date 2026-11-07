import type { ConversationProgress } from "./conversation-quality.js";

export interface AutonomySettings {
  enabled: boolean;
  paused: boolean;
  intervalMs: number;
  cooldownMs: number;
  maxActiveGoals: number;
  maxInferenceRequests: number;
  maxDurationMs: number;
  maxConversations: number;
  maxConversationMessages: number;
  maxConversationTokens: number;
  maxConversationParticipants: number;
  conversationExecutionEnabled: boolean;
  maxConcurrentConversationTurns: number;
  contextTokenBudget: number;
  conversationSoftTokenBudget: number;
  conversationHardTokenCeiling: number;
  conversationCheckpointTurns: number;
  lastCycleAt: string | null;
  updatedAt: string;
}

export interface GoalCycleRecord {
  id: string;
  outcome: string;
  rationale: string;
  goalId: string | null;
  prompt: Array<{ role: string; content: string }>;
  responseText: string | null;
  createdAt: string;
}

export interface ColonyGoalRecord {
  id: string;
  objectiveId: string;
  description: string;
  normalizedDescription: string;
  motivation: string;
  evidence: string[];
  hypotheses: string[];
  expectedBenefit: string;
  successCriteria: string[];
  estimatedInferenceRequests: number;
  departments: string[];
  priority: "low" | "medium" | "high";
  stopConditions: string[];
  status: "selected" | "cancelled" | "completed" | "failed";
  objectiveStatus: string;
  createdAt: string;
}

export interface SubgoalRecord {
  id: string;
  objectiveId: string;
  departmentId: string;
  agentId: string;
  description: string;
  status: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  topic: string;
  objectiveId: string | null;
  openedByDepartmentId: string;
  status: "open" | "resolved" | "unresolved" | "terminated";
  messageCount: number;
  inferenceRequests: number;
  inputTokens: number;
  outputTokens: number;
  maxMessages: number;
  maxTokens: number;
  maxDurationMs: number;
  closeReason: string | null;
  finalConclusion: string | null;
  remainingDisagreements: string[];
  evidenceRefs: string[];
  contextSummary: string | null;
  outcome: string | null;
  paused: boolean;
  runnerStatus: "idle" | "scheduled" | "running" | "paused" | "waiting_on_child" | "stopped";
  runnerFence: number;
  runnerLeaseUntil: string | null;
  parentConversationId: string | null;
  scheduledSpeakerId: string | null;
  recommendedSpeakerId: string | null;
  speakerRecommendationReason: string | null;
  lastError: string | null;
  lastInferenceLatencyMs: number | null;
  lastInferenceEndpoint: string | null;
  progressState: ConversationProgress;
  openingInstruction: string | null;
  openedAt: string;
  lastTurnAt: string;
  closedAt: string | null;
}

export interface ConversationTurnRecord {
  id: string;
  conversationId: string;
  messageId: string;
  departmentId: string;
  departmentSlug: string;
  kind: string;
  body: string;
  addressedDepartmentId: string | null;
  addressedDepartmentSlug: string | null;
  sequence: number;
  parentMessageId: string | null;
  prompt: Array<{ role: string; content: string }>;
  idempotencyKey: string;
  createdAt: string;
}

export interface DepartmentRef {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export type MembershipState = "active" | "invited" | "declined" | "removed";
export type MembershipAction = "joined" | "invited" | "accepted" | "declined" | "removed";
export type ParticipantRole = "opener" | "participant" | "specialist" | "evaluator";

export interface MembershipRecord {
  conversationId: string;
  departmentId: string;
  departmentSlug: string;
  membership: MembershipState;
  role: ParticipantRole;
  joinSequence: number;
  invitedByDepartmentId: string | null;
  joinedAt: string | null;
  removedAt: string | null;
}

export interface MembershipEventRecord {
  id: string;
  conversationId: string;
  departmentId: string;
  departmentSlug: string;
  action: MembershipAction;
  actorDepartmentId: string | null;
  reason: string;
  createdAt: string;
}

export interface TurnClaim {
  idempotencyKey: string;
  conversationId: string;
  departmentId: string;
  kind: string;
  addressedDepartmentId: string | null;
  parentMessageId: string | null;
  sequence: number;
  body: string | null;
  prompt: Array<{ role: string; content: string }> | null;
  inputTokens: number | null;
  outputTokens: number | null;
  updatedAt: string;
}

export interface ConversationJob {
  id: string;
  conversationId: string;
  idempotencyKey: string;
  fence: number;
  status: "pending" | "leased" | "completed" | "dead";
  action: "speak" | "invitation";
  attempt: number;
  leaseToken: string | null;
  leaseUntil: string | null;
  speakerDepartmentId: string | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ContextEventRecord {
  id: string;
  conversationId: string;
  departmentId: string | null;
  kind: "search" | "summary";
  query: string;
  messageIds: string[];
  tokens: number;
  createdAt: string;
}

export interface AutonomyRepository {
  settings(): Promise<AutonomySettings>;
  saveSettings(patch: Partial<Omit<AutonomySettings, "updatedAt" | "lastCycleAt">> & { lastCycleAt?: Date | null }): Promise<AutonomySettings>;
  insertCycle(input: Omit<GoalCycleRecord, "createdAt">): Promise<void>;
  listCycles(limit: number): Promise<GoalCycleRecord[]>;
  insertGoal(input: Omit<ColonyGoalRecord, "createdAt" | "objectiveStatus">): Promise<void>;
  listGoals(limit: number): Promise<ColonyGoalRecord[]>;
  findGoal(id: string): Promise<ColonyGoalRecord | null>;
  findActiveByDescription(normalized: string): Promise<ColonyGoalRecord | null>;
  countSelectedGoals(): Promise<number>;
  saveGoal(id: string, status: ColonyGoalRecord["status"]): Promise<void>;
  insertSubgoal(input: Omit<SubgoalRecord, "createdAt">): Promise<void>;
  findSubgoalByKey(key: string): Promise<SubgoalRecord | null>;
  listSubgoals(objectiveId: string): Promise<SubgoalRecord[]>;
  department(id: string): Promise<DepartmentRef | null>;
  insertConversation(input: Omit<ConversationRecord, "messageCount" | "inferenceRequests" | "inputTokens" | "outputTokens" | "closeReason" | "finalConclusion" | "remainingDisagreements" | "evidenceRefs" | "contextSummary" | "outcome" | "paused" | "runnerStatus" | "runnerFence" | "runnerLeaseUntil" | "parentConversationId" | "scheduledSpeakerId" | "recommendedSpeakerId" | "speakerRecommendationReason" | "lastError" | "lastInferenceLatencyMs" | "lastInferenceEndpoint" | "progressState" | "openedAt" | "lastTurnAt" | "closedAt"> & { id: string }): Promise<void>;
  findConversation(id: string): Promise<ConversationRecord | null>;
  lockConversation(id: string): Promise<ConversationRecord | null>;
  listConversations(limit: number): Promise<ConversationRecord[]>;
  saveConversation(id: string, patch: Partial<Pick<ConversationRecord, "status" | "closeReason" | "finalConclusion" | "remainingDisagreements" | "evidenceRefs" | "contextSummary" | "outcome" | "paused" | "runnerStatus" | "runnerFence" | "scheduledSpeakerId" | "recommendedSpeakerId" | "speakerRecommendationReason" | "lastError" | "parentConversationId" | "lastInferenceLatencyMs" | "lastInferenceEndpoint" | "progressState" | "maxTokens"> & { closedAt: Date | null; runnerLeaseUntil: Date | null }>): Promise<void>;
  addParticipant(conversationId: string, departmentId: string): Promise<void>;
  listParticipants(conversationId: string): Promise<string[]>;
  listMembership(conversationId: string): Promise<MembershipRecord[]>;
  upsertMembership(input: { conversationId: string; departmentId: string; membership: MembershipState; role: ParticipantRole; joinSequence: number; invitedByDepartmentId: string | null; joinedAt: Date | null; removedAt: Date | null }): Promise<void>;
  insertMembershipEvent(input: Omit<MembershipEventRecord, "createdAt" | "departmentSlug">): Promise<void>;
  listMembershipEvents(conversationId: string): Promise<MembershipEventRecord[]>;
  departmentAgent(departmentId: string): Promise<{ id: string; status: string } | null>;
  countOpenConversations(): Promise<number>;
  allocateSequence(conversationId: string): Promise<number>;
  insertTurn(input: Omit<ConversationTurnRecord, "createdAt" | "departmentSlug" | "addressedDepartmentSlug">): Promise<void>;
  findTurnByKey(key: string): Promise<ConversationTurnRecord | null>;
  listTurns(conversationId: string): Promise<ConversationTurnRecord[]>;
  findClaim(key: string): Promise<TurnClaim | null>;
  insertClaim(input: Omit<TurnClaim, "updatedAt" | "body" | "prompt" | "inputTokens" | "outputTokens"> & { body?: string | null; prompt?: Array<{ role: string; content: string }> | null; inputTokens?: number | null; outputTokens?: number | null; updatedAt?: Date }): Promise<void>;
  saveClaimBody(key: string, patch: { body: string; prompt: Array<{ role: string; content: string }>; inputTokens: number; outputTokens: number; at: Date }): Promise<void>;
  recordTurnUsage(conversationId: string, usage: { requests: number; inputTokens: number; outputTokens: number; at: Date }): Promise<void>;
  addContextTokens(conversationId: string, tokens: number): Promise<void>;
  countMemories(): Promise<number>;
  countBlockingHumanWork(): Promise<number>;
  searchTurns(conversationId: string, query: string, limit: number): Promise<ConversationTurnRecord[]>;
  insertContextEvent(input: Omit<ContextEventRecord, "createdAt">): Promise<void>;
  listContextEvents(conversationId: string): Promise<ContextEventRecord[]>;
  insertJob(input: Omit<ConversationJob, "attempt" | "leaseToken" | "leaseUntil" | "speakerDepartmentId" | "lastError" | "createdAt" | "completedAt">): Promise<void>;
  findJob(id: string): Promise<ConversationJob | null>;
  findActiveJob(conversationId: string): Promise<ConversationJob | null>;
  expireLeases(now: Date): Promise<void>;
  leaseJob(id: string, token: string, until: Date, speakerDepartmentId: string | null): Promise<boolean>;
  completeJob(id: string, token: string, at: Date): Promise<boolean>;
  releaseJob(id: string, token: string, error: string): Promise<boolean>;
  retireJob(id: string, error: string): Promise<void>;
  countLeasedJobs(): Promise<number>;
  countLeasedForDepartment(departmentId: string): Promise<number>;
}
