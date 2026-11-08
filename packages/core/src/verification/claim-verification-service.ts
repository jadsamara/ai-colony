import { randomUUID } from "node:crypto";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { Persistence } from "../ports/repositories.js";
import type {
  ClaimProvenance,
  ClaimVerificationRecord,
  ConversationClaimRecord,
} from "./claim-repository.js";
import { claimIdempotencyKey, extractNumericalClaims, formatRefutedClaimNotice } from "./extraction.js";
import { verifyNumericalClaim, type NumericalVerificationRequest } from "./numerical.js";

const FORBIDDEN_VERIFY_METHOD = /llm|model.agree|another model|auto.?agree|consensus of models/i;
const SYSTEM_VERIFIER = "system:deterministic_calculation";

export interface TurnClaimCaptureResult {
  extracted: number;
  created: number;
  skipped: number;
  verified: number;
  refuted: number;
  inconclusive: number;
  unverified: number;
  errors: string[];
  refutedNotices: string[];
}

export class ClaimVerificationService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordClaim(
    ctx: RequestContext,
    input: {
      conversationId: string;
      proposingDepartmentId: string;
      supportingTurnId?: string | null;
      claimText: string;
      provenance: ClaimProvenance;
      idempotencyKey?: string | null;
      normalizedExpression?: string | null;
    },
  ): Promise<ConversationClaimRecord> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const conversation = await this.persistence.repos.autonomy.findConversation(input.conversationId);
    if (!conversation) {
      throw notFound("Conversation", input.conversationId);
    }
    const department = await this.persistence.repos.autonomy.department(input.proposingDepartmentId);
    if (!department) {
      throw notFound("Department", input.proposingDepartmentId);
    }
    if (input.supportingTurnId) {
      const turns = await this.persistence.repos.autonomy.listTurns(input.conversationId);
      if (!turns.some((turn) => turn.id === input.supportingTurnId)) {
        throw new DomainError("VALIDATION_ERROR", "supportingTurnId is not part of this conversation", 422);
      }
    }
    const text = input.claimText.trim();
    if (!text || text.length > 4_000) {
      throw new DomainError("VALIDATION_ERROR", "claimText must be 1..4000 characters", 422);
    }
    const row = {
      id: randomUUID(),
      conversationId: input.conversationId,
      proposingDepartmentId: input.proposingDepartmentId,
      supportingTurnId: input.supportingTurnId ?? null,
      claimText: text,
      provenance: input.provenance,
      verificationStatus: "unverified" as const,
      verifierId: null,
      verificationMethod: null,
      idempotencyKey: input.idempotencyKey ?? null,
      normalizedExpression: input.normalizedExpression ?? null,
      createdAt: this.now().toISOString(),
      reviewedAt: null,
      revision: 1,
    };
    if (row.idempotencyKey) {
      return (await this.persistence.repos.claims.insertClaimIdempotent(row)).claim;
    }
    return this.persistence.repos.claims.insertClaim(row);
  }

  /**
   * Deterministic extract → idempotent persist → Phase A verify.
   * Does not call an LLM. Failures are returned in `errors` for the caller to record.
   */
  async captureTurnClaims(
    ctx: RequestContext,
    input: {
      conversationId: string;
      turnId: string;
      proposingDepartmentId: string;
      body: string;
      contextBodies?: readonly string[];
    },
  ): Promise<TurnClaimCaptureResult> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const summary: TurnClaimCaptureResult = {
      extracted: 0,
      created: 0,
      skipped: 0,
      verified: 0,
      refuted: 0,
      inconclusive: 0,
      unverified: 0,
      errors: [],
      refutedNotices: [],
    };
    const candidates = extractNumericalClaims({
      turnId: input.turnId,
      body: input.body,
      contextBodies: input.contextBodies,
    });
    summary.extracted = candidates.length;
    for (const candidate of candidates) {
      try {
        const key = claimIdempotencyKey(input.turnId, candidate.normalizedExpression);
        const existing = await this.persistence.repos.claims.findClaimByIdempotencyKey(key);
        let claim = existing;
        if (!claim) {
          const inserted = await this.persistence.repos.claims.insertClaimIdempotent({
            id: randomUUID(),
            conversationId: input.conversationId,
            proposingDepartmentId: input.proposingDepartmentId,
            supportingTurnId: input.turnId,
            claimText: candidate.claimText.slice(0, 4_000),
            provenance: "model_turn",
            verificationStatus: "unverified",
            verifierId: null,
            verificationMethod: null,
            idempotencyKey: key,
            normalizedExpression: candidate.normalizedExpression,
            createdAt: this.now().toISOString(),
            reviewedAt: null,
            revision: 1,
          });
          claim = inserted.claim;
          if (inserted.created) {
            summary.created += 1;
          } else {
            summary.skipped += 1;
          }
        } else {
          summary.skipped += 1;
        }

        if (claim.verificationStatus !== "unverified") {
          continue;
        }
        if (!candidate.verificationRequest) {
          if (claim.verificationStatus === "unverified") {
            await this.persistence.repos.claims.updateClaim(claim.id, {
              verificationStatus: "inconclusive",
              verifierId: SYSTEM_VERIFIER,
              verificationMethod: "deterministic_extraction_incomplete",
              reviewedAt: this.now().toISOString(),
              revision: claim.revision + 1,
            });
            summary.inconclusive += 1;
          }
          continue;
        }
        const verified = await this.verifyNumerical(ctx, claim.id, candidate.verificationRequest, SYSTEM_VERIFIER);
        if (verified.claim.verificationStatus === "verified") {
          summary.verified += 1;
        } else if (verified.claim.verificationStatus === "refuted") {
          summary.refuted += 1;
          summary.refutedNotices.push(
            formatRefutedClaimNotice({
              claimText: claim.claimText,
              computedValue: verified.verification.computedValue,
              claimedValue: verified.verification.claimedValue,
              turnId: input.turnId,
              diagnostic: verified.verification.diagnostic,
            }),
          );
        } else {
          summary.inconclusive += 1;
        }
      } catch (error) {
        summary.errors.push(error instanceof Error ? error.message.slice(0, 240) : "claim capture failed");
      }
    }
    return summary;
  }

  async verifyNumerical(
    ctx: RequestContext,
    claimId: string,
    request: NumericalVerificationRequest,
    verifierId = ctx.actor.principalId,
  ): Promise<{ claim: ConversationClaimRecord; verification: ClaimVerificationRecord }> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const claim = await this.persistence.repos.claims.findClaim(claimId);
    if (!claim) {
      throw notFound("ConversationClaim", claimId);
    }
    if (claim.verificationStatus !== "unverified") {
      const prior = await this.persistence.repos.claims.listVerificationsByClaim(claimId);
      const last = prior.at(-1);
      if (last) {
        return { claim, verification: last };
      }
    }
    const result = verifyNumericalClaim(request);
    const method = result.method;
    if (FORBIDDEN_VERIFY_METHOD.test(method)) {
      throw new DomainError(
        "VERIFICATION_METHOD_REJECTED",
        "A claim must not be marked verified merely because an LLM asserts agreement",
        400,
      );
    }
    const verification = await this.persistence.repos.claims.insertVerification({
      id: randomUUID(),
      claimId,
      method,
      verdict: result.verdict,
      inputs: result.inputs,
      outputs: result.outputs,
      units: result.units,
      tolerance: result.tolerance ? { ...result.tolerance } : null,
      diagnostic: result.diagnostic,
      computedValue: result.computedValue,
      claimedValue: result.claimedValue,
      verifierId,
      createdAt: this.now().toISOString(),
    });
    const updated = await this.persistence.repos.claims.updateClaim(claimId, {
      verificationStatus: result.verdict,
      verifierId,
      verificationMethod: method,
      reviewedAt: this.now().toISOString(),
      revision: claim.revision + 1,
    });
    return { claim: updated, verification };
  }

  /**
   * Explicit human/system review path. Rejects LLM-agreement methods for verified outcomes.
   */
  async reviewClaim(
    ctx: RequestContext,
    claimId: string,
    input: { decision: "verified" | "refuted" | "inconclusive"; method: string; evidence?: string | null },
  ): Promise<ConversationClaimRecord> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    if (FORBIDDEN_VERIFY_METHOD.test(input.method) && input.decision === "verified") {
      throw new DomainError(
        "VERIFICATION_METHOD_REJECTED",
        "A claim must not be marked verified merely because an LLM asserts agreement",
        400,
      );
    }
    const claim = await this.persistence.repos.claims.findClaim(claimId);
    if (!claim) {
      throw notFound("ConversationClaim", claimId);
    }
    if (claim.verificationStatus !== "unverified") {
      throw new DomainError("INVALID_STATE", "Claim already reviewed", 409);
    }
    return this.persistence.repos.claims.updateClaim(claimId, {
      verificationStatus: input.decision,
      verifierId: ctx.actor.principalId,
      verificationMethod: input.method.slice(0, 200),
      reviewedAt: this.now().toISOString(),
      revision: claim.revision + 1,
    });
  }

  async listClaims(ctx: RequestContext, conversationId: string, limit = 100) {
    this.authorizer.assertAny(ctx.actor, ["conversation:claims:read", "autonomy:manage", "message:read"]);
    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      throw notFound("Conversation", conversationId);
    }
    return this.persistence.repos.claims.listClaimsByConversation(conversationId, limit);
  }

  async getClaim(ctx: RequestContext, claimId: string) {
    this.authorizer.assertAny(ctx.actor, ["conversation:claims:read", "autonomy:manage", "message:read"]);
    const claim = await this.persistence.repos.claims.findClaim(claimId);
    if (!claim) {
      throw notFound("ConversationClaim", claimId);
    }
    const verifications = await this.persistence.repos.claims.listVerificationsByClaim(claimId);
    return { claim, verifications };
  }

  async listVerifications(ctx: RequestContext, conversationId: string, limit = 100) {
    this.authorizer.assertAny(ctx.actor, ["conversation:claims:read", "autonomy:manage", "message:read"]);
    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      throw notFound("Conversation", conversationId);
    }
    return this.persistence.repos.claims.listVerificationsByConversation(conversationId, limit);
  }
}
