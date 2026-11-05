import { createHash } from "node:crypto";
import { z } from "zod";

export const EVALUATION_CONTRACT_VERSION = "m8.2-evaluation-contract-v1" as const;

const setValue = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("set"), value }).strict(),
    z.object({ state: z.literal("unknown") }).strict(),
    z.object({ state: z.literal("omitted") }).strict(),
    z.object({ state: z.literal("disabled") }).strict(),
  ]);

const text = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const evaluationManifestSchema = z
  .object({
    contractVersion: z.literal(EVALUATION_CONTRACT_VERSION),
    model: z
      .object({
        family: setValue(text),
        identifier: setValue(text),
        alias: setValue(text),
        checkpointId: setValue(text),
        checkpointDigest: setValue(digest),
        adapterId: setValue(text),
        adapterVersion: setValue(text),
        adapterDigest: setValue(digest),
        quantization: setValue(text),
      })
      .strict(),
    backend: z.object({ id: setValue(text), version: setValue(text) }).strict(),
    evaluation: z
      .object({
        scope: setValue(text),
        benchmarkId: setValue(text),
        benchmarkVersion: setValue(text),
        itemSetFingerprint: setValue(digest),
        itemCount: setValue(z.number().int().nonnegative()),
        promptTemplateId: setValue(text),
        promptTemplateDigest: setValue(digest),
        systemPromptId: setValue(text),
        systemPromptDigest: setValue(digest),
        scorerId: setValue(text),
        scorerVersion: setValue(text),
        extractorId: setValue(text),
        extractorVersion: setValue(text),
        harnessVersion: setValue(text),
      })
      .strict(),
    generation: z
      .object({
        maxOutputTokens: setValue(z.number().int().positive()),
        temperature: setValue(z.number().min(0).max(2)),
        topP: setValue(z.number().min(0).max(1)),
        seed: setValue(z.number().int().nonnegative()),
        thinking: setValue(z.enum(["enabled", "disabled"])),
        stopSequences: setValue(z.array(z.string().max(80)).max(8)),
        contextWindow: setValue(z.number().int().positive()),
        tools: setValue(z.enum(["available", "unavailable"])),
        retrieval: setValue(z.enum(["closed_book", "retrieval_assisted"])),
      })
      .strict(),
    execution: z
      .object({
        runId: setValue(text),
        recordedAt: setValue(z.string().datetime()),
        environment: setValue(text),
        gitCommit: setValue(z.string().min(7).max(64)),
        status: setValue(z.enum(["completed", "failed", "partial"])),
        provenance: setValue(z.enum(["colony_database", "historical_file", "synthetic"])),
      })
      .strict(),
  })
  .strict();

export type EvaluationManifest = z.infer<typeof evaluationManifestSchema>;
export type ConfigPresence<T> = { state: "set"; value: T } | { state: "unknown" } | { state: "omitted" } | { state: "disabled" };

export function setConfig<T>(value: T): { state: "set"; value: T } {
  return { state: "set", value };
}

export function unknownConfig(): { state: "unknown" } {
  return { state: "unknown" };
}

export function omittedConfig(): { state: "omitted" } {
  return { state: "omitted" };
}

export function disabledConfig(): { state: "disabled" } {
  return { state: "disabled" };
}

export function parseEvaluationManifest(input: unknown): EvaluationManifest {
  return evaluationManifestSchema.parse(input);
}

export function contentDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function itemSetFingerprint(items: readonly { id: string; contentDigest: string }[]): string {
  const canonical = [...items]
    .map((item) => ({ id: item.id, contentDigest: item.contentDigest }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return contentDigest(canonicalize(canonical));
}

export function configurationFingerprint(manifest: EvaluationManifest): string {
  return contentDigest(
    canonicalize({
      contractVersion: manifest.contractVersion,
      quantization: manifest.model.quantization,
      backend: manifest.backend,
      evaluation: manifest.evaluation,
      generation: manifest.generation,
    }),
  );
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]));
}
