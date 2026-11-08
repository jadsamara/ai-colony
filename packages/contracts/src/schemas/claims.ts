import { z } from "zod";
import { uuidSchema } from "./common.js";

const isoSchema = z.string().datetime();

export const claimVerificationStatusSchema = z.enum(["unverified", "verified", "refuted", "inconclusive"]);
export const claimProvenanceSchema = z.enum(["model_turn", "human", "system", "evaluation"]);

export const conversationClaimSchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  proposingDepartmentId: uuidSchema,
  supportingTurnId: uuidSchema.nullable(),
  claimText: z.string(),
  provenance: claimProvenanceSchema,
  verificationStatus: claimVerificationStatusSchema,
  verifierId: z.string().nullable(),
  verificationMethod: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  normalizedExpression: z.string().nullable(),
  createdAt: isoSchema,
  reviewedAt: isoSchema.nullable(),
  revision: z.number().int().positive(),
});

export const claimVerificationSchema = z.object({
  id: uuidSchema,
  claimId: uuidSchema,
  method: z.string(),
  verdict: claimVerificationStatusSchema,
  inputs: z.record(z.unknown()),
  outputs: z.record(z.unknown()),
  units: z.record(z.string()),
  tolerance: z.record(z.unknown()).nullable(),
  diagnostic: z.string().nullable(),
  computedValue: z.number().nullable(),
  claimedValue: z.number().nullable(),
  verifierId: z.string(),
  createdAt: isoSchema,
});

export const conversationClaimListResponseSchema = z.object({
  conversationId: uuidSchema,
  claims: z.array(conversationClaimSchema),
});

export const conversationClaimDetailResponseSchema = z.object({
  claim: conversationClaimSchema,
  verifications: z.array(claimVerificationSchema),
});

export const conversationVerificationListResponseSchema = z.object({
  conversationId: uuidSchema,
  verifications: z.array(claimVerificationSchema),
});

export type ConversationClaim = z.infer<typeof conversationClaimSchema>;
export type ClaimVerification = z.infer<typeof claimVerificationSchema>;
