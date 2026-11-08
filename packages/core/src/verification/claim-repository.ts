export const CLAIM_VERIFICATION_STATUSES = ["unverified", "verified", "refuted", "inconclusive"] as const;
export type ClaimVerificationStatus = (typeof CLAIM_VERIFICATION_STATUSES)[number];

export const CLAIM_PROVENANCES = ["model_turn", "human", "system", "evaluation"] as const;
export type ClaimProvenance = (typeof CLAIM_PROVENANCES)[number];

export interface ConversationClaimRecord {
  id: string;
  conversationId: string;
  proposingDepartmentId: string;
  supportingTurnId: string | null;
  claimText: string;
  provenance: ClaimProvenance;
  verificationStatus: ClaimVerificationStatus;
  verifierId: string | null;
  verificationMethod: string | null;
  idempotencyKey: string | null;
  normalizedExpression: string | null;
  createdAt: string;
  reviewedAt: string | null;
  revision: number;
}

export interface ClaimVerificationRecord {
  id: string;
  claimId: string;
  method: string;
  verdict: ClaimVerificationStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  units: Record<string, string>;
  tolerance: Record<string, unknown> | null;
  diagnostic: string | null;
  computedValue: number | null;
  claimedValue: number | null;
  verifierId: string;
  createdAt: string;
}

export interface ClaimVerificationRepository {
  insertClaim(row: ConversationClaimRecord): Promise<ConversationClaimRecord>;
  /** Insert-or-return existing row when idempotencyKey collides. */
  insertClaimIdempotent(row: ConversationClaimRecord): Promise<{ claim: ConversationClaimRecord; created: boolean }>;
  updateClaim(
    id: string,
    patch: Partial<
      Pick<
        ConversationClaimRecord,
        "verificationStatus" | "verifierId" | "verificationMethod" | "reviewedAt" | "revision"
      >
    >,
  ): Promise<ConversationClaimRecord>;
  findClaim(id: string): Promise<ConversationClaimRecord | null>;
  findClaimByIdempotencyKey(key: string): Promise<ConversationClaimRecord | null>;
  listClaimsByConversation(conversationId: string, limit?: number): Promise<ConversationClaimRecord[]>;
  insertVerification(row: ClaimVerificationRecord): Promise<ClaimVerificationRecord>;
  listVerificationsByClaim(claimId: string): Promise<ClaimVerificationRecord[]>;
  listVerificationsByConversation(conversationId: string, limit?: number): Promise<ClaimVerificationRecord[]>;
  findVerification(id: string): Promise<ClaimVerificationRecord | null>;
}
