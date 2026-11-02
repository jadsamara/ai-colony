import { configurationFingerprint, type EvaluationManifest } from "./manifest.js";

export type ComparisonDesign = "strict" | "qualified" | "noncomparable" | "indeterminate";

export interface ComparisonResult {
  comparable: boolean;
  design: ComparisonDesign;
  reasons: string[];
  matched: string[];
  differed: string[];
  missing: string[];
  allowedDifferences: string[];
  confounders: string[];
  pairedComparisonPossible: boolean;
  baselineReevaluationRequired: boolean;
  configurationFingerprint: { left: string; right: string };
}

const REQUIRED = [
  "evaluation.benchmarkId",
  "evaluation.benchmarkVersion",
  "evaluation.itemSetFingerprint",
  "evaluation.promptTemplateDigest",
  "evaluation.systemPromptDigest",
  "evaluation.scorerId",
  "evaluation.scorerVersion",
  "evaluation.extractorId",
  "evaluation.extractorVersion",
  "evaluation.harnessVersion",
  "generation.maxOutputTokens",
  "generation.temperature",
  "generation.topP",
  "generation.thinking",
  "generation.retrieval",
  "generation.tools",
  "model.quantization",
  "backend.id",
  "backend.version",
] as const;

const ALLOWED_DIFFERENCES = [
  "model.family",
  "model.identifier",
  "model.alias",
  "model.checkpointId",
  "model.checkpointDigest",
  "model.adapterId",
  "model.adapterVersion",
  "model.adapterDigest",
] as const;

const CONFOUNDERS = ["model.quantization", "backend.id", "backend.version"] as const;

export function compareManifests(
  left: EvaluationManifest,
  right: EvaluationManifest,
  design: { kind: "strict" } | { kind: "qualified"; acceptedConfounders: readonly string[] } = { kind: "strict" },
): ComparisonResult {
  const matched: string[] = [];
  const differed: string[] = [];
  const missing: string[] = [];
  const allowedDifferences: string[] = [];
  const confounders: string[] = [];
  const reasons: string[] = [];

  for (const path of [...REQUIRED, ...ALLOWED_DIFFERENCES]) {
    const leftValue = readPath(left, path);
    const rightValue = readPath(right, path);
    if (leftValue.state === "unknown" || rightValue.state === "unknown") {
      missing.push(path);
      continue;
    }
    if (canonical(leftValue) === canonical(rightValue)) {
      matched.push(path);
      continue;
    }
    differed.push(path);
    if ((ALLOWED_DIFFERENCES as readonly string[]).includes(path)) {
      allowedDifferences.push(path);
    }
    if ((CONFOUNDERS as readonly string[]).includes(path)) {
      confounders.push(path);
    }
  }

  const blocking = differed.filter((path) => !(ALLOWED_DIFFERENCES as readonly string[]).includes(path));
  const accepted = design.kind === "qualified" ? design.acceptedConfounders : [];
  const unaccepted = blocking.filter((path) => {
    const confounder = (CONFOUNDERS as readonly string[]).includes(path);
    return !confounder || !accepted.includes(path);
  });
  const itemSetsDiffer = differed.includes("evaluation.itemSetFingerprint");
  if (missing.length > 0) {
    reasons.push("Required evaluation evidence is missing.");
  }
  if (itemSetsDiffer) {
    reasons.push("Benchmark item sets differ.");
  }
  if (blocking.some((path) => path.startsWith("generation.") || path.startsWith("evaluation."))) {
    reasons.push("Generation, prompt, scoring, or harness settings differ.");
  }
  if (confounders.length > 0) {
    reasons.push("Inference backend or quantization differs.");
  }

  const comparable = missing.length === 0 && unaccepted.length === 0;
  let outcome: ComparisonDesign = "noncomparable";
  if (missing.length > 0) {
    outcome = "indeterminate";
  } else if (comparable && design.kind === "qualified") {
    outcome = "qualified";
  } else if (comparable) {
    outcome = "strict";
  }
  return {
    comparable,
    design: outcome,
    reasons,
    matched,
    differed,
    missing,
    allowedDifferences,
    confounders,
    pairedComparisonPossible: comparable,
    baselineReevaluationRequired: !comparable,
    configurationFingerprint: {
      left: configurationFingerprint(left),
      right: configurationFingerprint(right),
    },
  };
}

function readPath(manifest: EvaluationManifest, path: string): { state: string; value?: unknown } {
  const [group, field] = path.split(".");
  const record = manifest[group as keyof EvaluationManifest];
  if (!record || typeof record !== "object") {
    return { state: "unknown" };
  }
  const value = record[field as keyof typeof record];
  if (!value || typeof value !== "object" || !("state" in value)) {
    return { state: "unknown" };
  }
  return value as { state: string; value?: unknown };
}

function canonical(value: { state: string; value?: unknown }): string {
  return JSON.stringify(value);
}
