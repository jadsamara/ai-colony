import type { RoutingConfidence, RoutingMethod } from "./department-routing.js";

export interface DepartmentRoutingDecisionRecord {
  id: string;
  idempotencyKey: string;
  taskText: string;
  objectiveId: string | null;
  method: RoutingMethod;
  primaryDepartmentId: string;
  recommendedDepartmentIds: string[];
  rejectedRecommendations: Array<Record<string, unknown>>;
  finalParticipantIds: string[];
  rationale: string;
  confidence: RoutingConfidence;
  uncertainty: string | null;
  approvalRequired: boolean;
  modelMetadata: Record<string, unknown> | null;
  fallbackReason: string | null;
  createdBy: string;
  correlationId: string;
  createdAt: string;
}

export interface DepartmentRoutingRepository {
  insert(row: DepartmentRoutingDecisionRecord): Promise<DepartmentRoutingDecisionRecord>;
  findByIdempotencyKey(key: string): Promise<DepartmentRoutingDecisionRecord | null>;
  findById(id: string): Promise<DepartmentRoutingDecisionRecord | null>;
  listRecent(limit: number): Promise<DepartmentRoutingDecisionRecord[]>;
}
