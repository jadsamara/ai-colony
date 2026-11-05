import type { LiveModelHealth } from "@ai-colony/contracts";

export interface PersistedRuntimeStatus {
  runtimeStatus: string;
  expectedAlias: string | null;
  loadedModelId: string | null;
  endpointUrl: string | null;
  lastError: string | null;
  probedAt: string | null;
}

export interface ModelObservation {
  checkedAt: string;
  reachable: boolean;
  version: string | null;
  installedNames: string[];
  loadedNames: string[];
  errors: Array<{ endpoint: string; message: string }>;
  stale: boolean;
}

export function aliasListed(names: readonly string[], alias: string): boolean {
  return names.includes(alias);
}

export function ollamaManifestPath(alias: string, homeDirectory: string): string | null {
  const [name, tag = "latest"] = alias.split(":");
  if (!name || !tag || /[\\/]|\.\./.test(name) || /[\\/]|\.\./.test(tag)) {
    return null;
  }
  return `${homeDirectory}/.ollama/models/manifests/registry.ollama.ai/library/${name}/${tag}`;
}

export function artifactPresence(
  alias: string,
  homeDirectory: string,
  exists: (path: string) => boolean,
): "present" | "absent" | "unknown" {
  const path = ollamaManifestPath(alias, homeDirectory);
  if (!path) {
    return "unknown";
  }
  try {
    return exists(path) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

export function inferenceReadiness(input: {
  reachable: boolean;
  loaded: boolean;
  lastSuccessfulInferenceAt: string | null;
  now: number;
  freshnessMs: number;
}): "verified" | "unavailable" | "unknown" {
  if (!input.reachable) {
    return "unavailable";
  }
  if (!input.loaded || !input.lastSuccessfulInferenceAt) {
    return "unknown";
  }
  const at = Date.parse(input.lastSuccessfulInferenceAt);
  if (!Number.isFinite(at) || input.now - at > input.freshnessMs) {
    return "unknown";
  }
  return "verified";
}

export function describeModelHealth(input: {
  alias: string;
  registered: boolean;
  artifacts: "present" | "absent" | "unknown";
  persisted: PersistedRuntimeStatus | null;
  observation: ModelObservation;
  lastSuccessfulInferenceAt: string | null;
  now: number;
  freshnessMs: number;
}): LiveModelHealth {
  const tagsFailed = input.observation.errors.some((error) => error.endpoint === "/api/tags");
  const psFailed = input.observation.errors.some((error) => error.endpoint === "/api/ps");
  const installed = !tagsFailed && aliasListed(input.observation.installedNames, input.alias);
  const loaded = !psFailed && aliasListed(input.observation.loadedNames, input.alias);
  let inferenceReady = inferenceReadiness({
    reachable: input.observation.reachable,
    loaded,
    lastSuccessfulInferenceAt: input.lastSuccessfulInferenceAt,
    now: input.now,
    freshnessMs: input.freshnessMs,
  });
  if (input.observation.stale && inferenceReady === "verified") {
    inferenceReady = "unknown";
  }
  return {
    alias: input.alias,
    persisted_status: input.persisted
      ? {
          runtimeStatus: input.persisted.runtimeStatus,
          expectedAlias: input.persisted.expectedAlias,
          loadedModelId: input.persisted.loadedModelId,
          endpointUrl: input.persisted.endpointUrl,
          lastError: input.persisted.lastError,
          probedAt: input.persisted.probedAt,
        }
      : null,
    live_status: {
      registered: input.registered,
      artifacts_present: input.artifacts,
      reachable: input.observation.reachable,
      installed,
      loaded,
      unavailable: !input.observation.reachable,
    },
    checked_at: input.observation.checkedAt,
    stale: input.observation.stale,
    inference_ready: inferenceReady,
    evidence: {
      version: input.observation.version,
      installed_models: input.observation.installedNames,
      loaded_models: input.observation.loadedNames,
      errors: input.observation.errors,
      last_successful_inference_at: input.lastSuccessfulInferenceAt,
    },
  };
}
