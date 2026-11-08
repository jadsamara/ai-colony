import type { JoinConfidence, JoinRequestStatus } from "./department-join.js";

export interface DepartmentJoinRequestRecord {
  id: string;
  idempotencyKey: string;
  conversationId: string;
  requesterDepartmentId: string;
  targetDepartmentId: string;
  justification: string;
  status: JoinRequestStatus;
  decisionRationale: string | null;
  confidence: JoinConfidence | null;
  taskBrief: string | null;
  inferenceRequestId: string | null;
  modelMetadata: Record<string, unknown> | null;
  failureReason: string | null;
  createdBy: string;
  correlationId: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface DepartmentJoinRequestRepository {
  insert(row: DepartmentJoinRequestRecord): Promise<DepartmentJoinRequestRecord>;
  findByIdempotencyKey(key: string): Promise<DepartmentJoinRequestRecord | null>;
  findById(id: string): Promise<DepartmentJoinRequestRecord | null>;
  listByConversation(conversationId: string, limit?: number): Promise<DepartmentJoinRequestRecord[]>;
}
