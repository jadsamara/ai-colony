import type { RuntimeEvidence, RuntimeReadiness } from "./types.js";

export const LARGE_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
export const ADVISORY_MACHINE_MEMORY_BYTES = 24 * 1024 * 1024 * 1024;
export const RESERVED_HEADROOM_BYTES = 8 * 1024 * 1024 * 1024;

export interface CatalogModel {
  name: string;
  digest: string | null;
  sizeBytes: number | null;
}

export interface LiveServingAssessment {
  evidence: RuntimeEvidence;
  resourceAllowed: boolean;
  memoryKnown: boolean;
  resourceDetail: string;
  enforcement: "distinct_large_model_limit" | "artifact_headroom" | "not_measured";
}

export function assessLiveServing(input: {
  requestedAlias: string;
  reachable: boolean;
  stale: boolean;
  checkedAt: string | null;
  installed: readonly CatalogModel[];
  loaded: readonly CatalogModel[];
}): LiveServingAssessment {
  const installed = input.installed.find((model) => model.name === input.requestedAlias) ?? null;
  const loaded = input.loaded.find((model) => model.name === input.requestedAlias) ?? null;
  const otherLarge = input.loaded.filter((model) => model.name !== input.requestedAlias && countsAsLarge(model));
  const artifactBytes = installed?.sizeBytes ?? loaded?.sizeBytes ?? null;
  const exceedsHeadroom = artifactBytes !== null && artifactBytes > ADVISORY_MACHINE_MEMORY_BYTES - RESERVED_HEADROOM_BYTES;
  const distinctDenied = otherLarge.length > 0;
  const resourceAllowed = !distinctDenied && !exceedsHeadroom;
  const memoryKnown = loaded?.sizeBytes !== null && loaded?.sizeBytes !== undefined;
  let enforcement: LiveServingAssessment["enforcement"] = "not_measured";
  let resourceDetail = memoryKnown
    ? "The requested model reported a loaded size. That size is not a machine-wide memory limit."
    : "Resident memory was not measured. Artifact size is not treated as a memory limit.";
  if (distinctDenied) {
    enforcement = "distinct_large_model_limit";
    resourceDetail = "A different large or unsized model is already loaded. This process does not unload it or select a fallback.";
  } else if (exceedsHeadroom) {
    enforcement = "artifact_headroom";
    resourceDetail = "The requested artifact exceeds the reserved headroom on a 24 GB machine. This is an artifact-size check, not a measured memory limit.";
  }
  return {
    evidence: {
      state: evidenceState(input, installed !== null, loaded !== null),
      capturedAt: input.reachable ? input.checkedAt : null,
      digest: installed?.digest ?? loaded?.digest ?? null,
      servingTag: installed || loaded ? input.requestedAlias : null,
      artifactBytes,
      loadedCount: input.loaded.length,
    },
    resourceAllowed,
    memoryKnown,
    resourceDetail,
    enforcement,
  };
}

function countsAsLarge(model: CatalogModel): boolean {
  return model.sizeBytes === null || model.sizeBytes >= LARGE_ARTIFACT_BYTES;
}

function evidenceState(
  input: { reachable: boolean; stale: boolean },
  installed: boolean,
  loaded: boolean,
): RuntimeReadiness {
  if (!input.reachable) {
    return "runtime_unreachable";
  }
  if (input.stale) {
    return "evidence_stale";
  }
  if (loaded) {
    return "loaded";
  }
  if (installed) {
    return "installed";
  }
  return "registered";
}
