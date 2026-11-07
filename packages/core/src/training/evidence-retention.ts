import { createHash } from "node:crypto";
import { redactSensitive } from "../autonomy/policy.js";

export interface EvidenceRetentionConfig {
  rawMaxChars: number;
  promptMaxChars: number;
  retentionDays: number;
}

export const DEFAULT_EVIDENCE_RETENTION: EvidenceRetentionConfig = {
  rawMaxChars: Number(process.env.TRAINING_EVIDENCE_RAW_MAX_CHARS ?? 65_536),
  promptMaxChars: Number(process.env.TRAINING_EVIDENCE_PROMPT_MAX_CHARS ?? 32_768),
  retentionDays: Number(process.env.TRAINING_EVIDENCE_RETENTION_DAYS ?? 90),
};

export interface RetainedPayload {
  content: string | null;
  hash: string;
  truncated: boolean;
  redacted: boolean;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Redact known secret patterns, then truncate. Redaction is best-effort —
 * credentials that do not match existing patterns may remain.
 */
export function retainPayload(raw: string, maxChars: number): RetainedPayload {
  const redacted = redactSensitive(raw);
  const truncated = redacted.length > maxChars;
  const content = truncated ? redacted.slice(0, maxChars) : redacted;
  return {
    content,
    hash: sha256Text(redacted),
    truncated,
    redacted: redacted !== raw,
  };
}

export function promptSnapshot(
  messages: Array<{ role: string; content: string }>,
  maxChars: number,
): RetainedPayload {
  const joined = messages.map((message) => `${message.role}: ${message.content}`).join("\n---\n");
  return retainPayload(joined, maxChars);
}

export function retentionExpiresAt(from: Date, days: number): Date {
  return new Date(from.getTime() + Math.max(1, days) * 24 * 60 * 60 * 1000);
}
