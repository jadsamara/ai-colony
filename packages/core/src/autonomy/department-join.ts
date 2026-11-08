import { z } from "zod";

export const JOIN_REQUEST_STATUSES = ["pending", "approved", "rejected", "failed"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const JOIN_CONFIDENCE = ["high", "medium", "low"] as const;
export type JoinConfidence = (typeof JOIN_CONFIDENCE)[number];

export const orchestrationJoinSchema = z
  .object({
    approve: z.boolean(),
    rationale: z.string().trim().min(1).max(1_000),
    confidence: z.enum(JOIN_CONFIDENCE),
  })
  .strict();

export type OrchestrationJoinDraft = z.infer<typeof orchestrationJoinSchema>;

export const ORCHESTRATION_JOIN_SCHEMA = [
  "Return one JSON object and no other text.",
  'Required schema: {"approve":boolean,"rationale":"string","confidence":"high"|"medium"|"low"}.',
  "approve=true only when the named target department is necessary and appropriate for the stated justification.",
  "approve=false when the request is unnecessary, out of scope, redundant, or unsafe.",
  "Do not invent departments. Do not grant permissions. Do not request training, promotion, or department creation.",
  "Do not treat this as permanent authority for the target department.",
].join(" ");

export function buildJoinTaskBrief(input: {
  targetSlug: string;
  justification: string;
  rationale: string;
}): string {
  return [
    `Orchestration approved inviting ${input.targetSlug} into this conversation.`,
    `Assigned task: ${input.justification.trim()}`,
    `Decision rationale: ${input.rationale.trim()}`,
    "Use only the conversation transcript and this brief. Do not treat this as reusable colony knowledge.",
  ].join("\n");
}
