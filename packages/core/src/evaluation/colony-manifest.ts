import { compareManifests, type ComparisonResult } from "./compare.js";
import {
  disabledConfig,
  EVALUATION_CONTRACT_VERSION,
  omittedConfig,
  parseEvaluationManifest,
  setConfig,
  unknownConfig,
  type EvaluationManifest,
} from "./manifest.js";

export interface ColonyManifestInput {
  runId: string;
  recordedAt: string;
  family: string;
  identifier: string;
  alias: string;
  checkpointId: string;
  checkpointDigest: string;
  adapterId: string;
  adapterVersion: string;
  adapterDigest: string;
  quantization: string;
  backendId: string;
  backendVersion: string;
  benchmarkId: string;
  benchmarkVersion: string;
  itemSetFingerprint: string;
  itemCount: number;
  promptTemplateDigest: string;
  scorerId: string;
  scorerVersion: string;
  maxOutputTokens: number;
  temperature: number;
  contextWindow: number;
}

export function colonyRunContract(input: ColonyManifestInput): {
  baseline: EvaluationManifest;
  candidate: EvaluationManifest;
  comparison: ComparisonResult;
} {
  const shared = sharedManifest(input);
  const baseline = parseEvaluationManifest({
    ...shared,
    model: { ...shared.model, adapterId: disabledConfig(), adapterVersion: disabledConfig(), adapterDigest: disabledConfig() },
  });
  const candidate = parseEvaluationManifest({
    ...shared,
    model: {
      ...shared.model,
      adapterId: setConfig(input.adapterId),
      adapterVersion: setConfig(input.adapterVersion),
      adapterDigest: setConfig(input.adapterDigest),
    },
  });
  return { baseline, candidate, comparison: compareManifests(baseline, candidate) };
}

export function readStoredContract(decoding: Record<string, unknown>): {
  baseline: EvaluationManifest;
  candidate: EvaluationManifest;
} | null {
  const stored = decoding.evaluationContract;
  if (!stored || typeof stored !== "object") {
    return null;
  }
  const record = stored as { baseline?: unknown; candidate?: unknown };
  try {
    return {
      baseline: parseEvaluationManifest(record.baseline),
      candidate: parseEvaluationManifest(record.candidate),
    };
  } catch {
    return null;
  }
}

export function legacyManifest(input: {
  decoding: Record<string, unknown>;
  benchmarkId: string | null;
  benchmarkVersion: string | null;
  itemSetFingerprint: string | null;
  promptTemplateDigest: string | null;
  scorerId: string | null;
  scorerVersion: string | null;
  checkpointDigest: string | null;
  adapterDigest: string | null;
}): EvaluationManifest {
  const maxTokens = finiteNumber(input.decoding.maxTokens);
  const temperature = finiteNumber(input.decoding.temperature);
  return parseEvaluationManifest({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    model: {
      family: unknownConfig(),
      identifier: unknownConfig(),
      alias: unknownConfig(),
      checkpointId: unknownConfig(),
      checkpointDigest: digestOrUnknown(input.checkpointDigest),
      adapterId: unknownConfig(),
      adapterVersion: unknownConfig(),
      adapterDigest: input.adapterDigest === null ? disabledConfig() : digestOrUnknown(input.adapterDigest),
      quantization: unknownConfig(),
    },
    backend: { id: unknownConfig(), version: unknownConfig() },
    evaluation: {
      scope: unknownConfig(),
      benchmarkId: textOrUnknown(input.benchmarkId),
      benchmarkVersion: textOrUnknown(input.benchmarkVersion),
      itemSetFingerprint: digestOrUnknown(input.itemSetFingerprint),
      itemCount: unknownConfig(),
      promptTemplateId: unknownConfig(),
      promptTemplateDigest: digestOrUnknown(input.promptTemplateDigest),
      systemPromptId: unknownConfig(),
      systemPromptDigest: unknownConfig(),
      scorerId: textOrUnknown(input.scorerId),
      scorerVersion: textOrUnknown(input.scorerVersion),
      extractorId: unknownConfig(),
      extractorVersion: unknownConfig(),
      harnessVersion: unknownConfig(),
    },
    generation: {
      maxOutputTokens: maxTokens === null ? unknownConfig() : setConfig(maxTokens),
      temperature: temperature === null ? unknownConfig() : setConfig(temperature),
      topP: unknownConfig(),
      seed: unknownConfig(),
      thinking: unknownConfig(),
      stopSequences: unknownConfig(),
      contextWindow: unknownConfig(),
      tools: unknownConfig(),
      retrieval: unknownConfig(),
    },
    execution: {
      runId: unknownConfig(),
      recordedAt: unknownConfig(),
      environment: unknownConfig(),
      gitCommit: unknownConfig(),
      status: unknownConfig(),
      provenance: setConfig("colony_database"),
    },
  });
}

function sharedManifest(input: ColonyManifestInput) {
  return {
    contractVersion: EVALUATION_CONTRACT_VERSION,
    model: {
      family: setConfig(input.family),
      identifier: setConfig(input.identifier),
      alias: setConfig(input.alias),
      checkpointId: setConfig(input.checkpointId),
      checkpointDigest: setConfig(input.checkpointDigest),
      adapterId: disabledConfig(),
      adapterVersion: disabledConfig(),
      adapterDigest: disabledConfig(),
      quantization: setConfig(input.quantization),
    },
    backend: { id: setConfig(input.backendId), version: setConfig(input.backendVersion) },
    evaluation: {
      scope: setConfig("candidate_gate"),
      benchmarkId: setConfig(input.benchmarkId),
      benchmarkVersion: setConfig(input.benchmarkVersion),
      itemSetFingerprint: setConfig(input.itemSetFingerprint),
      itemCount: setConfig(input.itemCount),
      promptTemplateId: setConfig("colony-arithmetic-template"),
      promptTemplateDigest: setConfig(input.promptTemplateDigest),
      systemPromptId: disabledConfig(),
      systemPromptDigest: disabledConfig(),
      scorerId: setConfig(input.scorerId),
      scorerVersion: setConfig(input.scorerVersion),
      extractorId: setConfig(input.scorerId),
      extractorVersion: setConfig(input.scorerVersion),
      harnessVersion: setConfig(EVALUATION_CONTRACT_VERSION),
    },
    generation: {
      maxOutputTokens: setConfig(input.maxOutputTokens),
      temperature: setConfig(input.temperature),
      topP: disabledConfig(),
      seed: disabledConfig(),
      thinking: setConfig("disabled" as const),
      stopSequences: omittedConfig(),
      contextWindow: setConfig(input.contextWindow),
      tools: setConfig("unavailable" as const),
      retrieval: setConfig("closed_book" as const),
    },
    execution: {
      runId: setConfig(input.runId),
      recordedAt: setConfig(input.recordedAt),
      environment: setConfig(input.backendId),
      gitCommit: unknownConfig(),
      status: setConfig("completed" as const),
      provenance: setConfig("colony_database" as const),
    },
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrUnknown(value: string | null): { state: "set"; value: string } | { state: "unknown" } {
  return value && value.length > 0 ? setConfig(value) : unknownConfig();
}

function digestOrUnknown(value: string | null): { state: "set"; value: string } | { state: "unknown" } {
  return value && /^[a-f0-9]{64}$/.test(value) ? setConfig(value) : unknownConfig();
}
