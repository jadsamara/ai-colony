import { asc, desc, eq } from "drizzle-orm";
import type {
  ClaimVerificationRecord,
  ClaimVerificationRepository,
  ConversationClaimRecord,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import { conversationClaims, conversationClaimVerifications } from "../schema/index.js";

export function createClaimVerificationRepository(db: DbExecutor): ClaimVerificationRepository {
  return {
    async insertClaim(row) {
      return guard(async () => {
        const [saved] = await db
          .insert(conversationClaims)
          .values(claimValues(row))
          .returning();
        if (!saved) {
          throw new Error("conversation_claims insert returned no row");
        }
        return mapClaim(saved);
      });
    },

    async insertClaimIdempotent(row) {
      return guard(async () => {
        if (row.idempotencyKey) {
          const existing = await db
            .select()
            .from(conversationClaims)
            .where(eq(conversationClaims.idempotencyKey, row.idempotencyKey))
            .limit(1);
          if (existing[0]) {
            return { claim: mapClaim(existing[0]), created: false };
          }
        }
        const inserted = await db
          .insert(conversationClaims)
          .values(claimValues(row))
          .onConflictDoNothing({ target: conversationClaims.idempotencyKey })
          .returning();
        if (inserted[0]) {
          return { claim: mapClaim(inserted[0]), created: true };
        }
        if (row.idempotencyKey) {
          const [replay] = await db
            .select()
            .from(conversationClaims)
            .where(eq(conversationClaims.idempotencyKey, row.idempotencyKey))
            .limit(1);
          if (replay) {
            return { claim: mapClaim(replay), created: false };
          }
        }
        throw new Error("conversation_claims idempotent insert failed");
      });
    },

    async updateClaim(id, patch) {
      return guard(async () => {
        const [saved] = await db
          .update(conversationClaims)
          .set({
            ...(patch.verificationStatus !== undefined ? { verificationStatus: patch.verificationStatus } : {}),
            ...(patch.verifierId !== undefined ? { verifierId: patch.verifierId } : {}),
            ...(patch.verificationMethod !== undefined ? { verificationMethod: patch.verificationMethod } : {}),
            ...(patch.reviewedAt !== undefined ? { reviewedAt: patch.reviewedAt ? new Date(patch.reviewedAt) : null } : {}),
            ...(patch.revision !== undefined ? { revision: patch.revision } : {}),
          })
          .where(eq(conversationClaims.id, id))
          .returning();
        if (!saved) {
          throw new Error(`conversation_claims update missed ${id}`);
        }
        return mapClaim(saved);
      });
    },

    async findClaim(id) {
      const [row] = await db.select().from(conversationClaims).where(eq(conversationClaims.id, id)).limit(1);
      return row ? mapClaim(row) : null;
    },

    async findClaimByIdempotencyKey(key) {
      const [row] = await db
        .select()
        .from(conversationClaims)
        .where(eq(conversationClaims.idempotencyKey, key))
        .limit(1);
      return row ? mapClaim(row) : null;
    },

    async listClaimsByConversation(conversationId, limit = 100) {
      const rows = await db
        .select()
        .from(conversationClaims)
        .where(eq(conversationClaims.conversationId, conversationId))
        .orderBy(asc(conversationClaims.createdAt))
        .limit(Math.min(Math.max(limit, 1), 200));
      return rows.map(mapClaim);
    },

    async insertVerification(row) {
      return guard(async () => {
        const [saved] = await db
          .insert(conversationClaimVerifications)
          .values({
            id: row.id,
            claimId: row.claimId,
            method: row.method,
            verdict: row.verdict,
            inputs: row.inputs,
            outputs: row.outputs,
            units: row.units,
            tolerance: row.tolerance,
            diagnostic: row.diagnostic,
            computedValue: row.computedValue,
            claimedValue: row.claimedValue,
            verifierId: row.verifierId,
            createdAt: new Date(row.createdAt),
          })
          .returning();
        if (!saved) {
          throw new Error("conversation_claim_verifications insert returned no row");
        }
        return mapVerification(saved);
      });
    },

    async listVerificationsByClaim(claimId) {
      const rows = await db
        .select()
        .from(conversationClaimVerifications)
        .where(eq(conversationClaimVerifications.claimId, claimId))
        .orderBy(asc(conversationClaimVerifications.createdAt));
      return rows.map(mapVerification);
    },

    async listVerificationsByConversation(conversationId, limit = 100) {
      const rows = await db
        .select({ verification: conversationClaimVerifications })
        .from(conversationClaimVerifications)
        .innerJoin(conversationClaims, eq(conversationClaims.id, conversationClaimVerifications.claimId))
        .where(eq(conversationClaims.conversationId, conversationId))
        .orderBy(desc(conversationClaimVerifications.createdAt))
        .limit(Math.min(Math.max(limit, 1), 200));
      return rows.map((row) => mapVerification(row.verification));
    },

    async findVerification(id) {
      const [row] = await db
        .select()
        .from(conversationClaimVerifications)
        .where(eq(conversationClaimVerifications.id, id))
        .limit(1);
      return row ? mapVerification(row) : null;
    },
  };
}

function claimValues(row: ConversationClaimRecord) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    proposingDepartmentId: row.proposingDepartmentId,
    supportingTurnId: row.supportingTurnId,
    claimText: row.claimText,
    provenance: row.provenance,
    verificationStatus: row.verificationStatus,
    verifierId: row.verifierId,
    verificationMethod: row.verificationMethod,
    idempotencyKey: row.idempotencyKey,
    normalizedExpression: row.normalizedExpression,
    createdAt: new Date(row.createdAt),
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt) : null,
    revision: row.revision,
  };
}

function mapClaim(row: typeof conversationClaims.$inferSelect): ConversationClaimRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    proposingDepartmentId: row.proposingDepartmentId,
    supportingTurnId: row.supportingTurnId,
    claimText: row.claimText,
    provenance: row.provenance as ConversationClaimRecord["provenance"],
    verificationStatus: row.verificationStatus as ConversationClaimRecord["verificationStatus"],
    verifierId: row.verifierId,
    verificationMethod: row.verificationMethod,
    idempotencyKey: row.idempotencyKey,
    normalizedExpression: row.normalizedExpression,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    revision: row.revision,
  };
}

function mapVerification(row: typeof conversationClaimVerifications.$inferSelect): ClaimVerificationRecord {
  return {
    id: row.id,
    claimId: row.claimId,
    method: row.method,
    verdict: row.verdict as ClaimVerificationRecord["verdict"],
    inputs: row.inputs,
    outputs: row.outputs,
    units: row.units,
    tolerance: row.tolerance,
    diagnostic: row.diagnostic,
    computedValue: row.computedValue,
    claimedValue: row.claimedValue,
    verifierId: row.verifierId,
    createdAt: row.createdAt.toISOString(),
  };
}
