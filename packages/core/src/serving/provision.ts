import type { DedicatedServingInstance } from "./types.js";

export interface ArtifactObservation {
  instanceId: string;
  /** Null when the department volume has no recorded artifact. */
  recordedDigest: string | null;
  /** Bytes already stored, when the host measured them. Null means not measured. */
  measuredBytes: number | null;
}

export interface ArtifactPlan {
  instanceId: string;
  departmentId: string;
  modelVersion: string;
  volume: string;
  action: "reuse" | "mock" | "missing" | "mismatch" | "digest_unconfigured";
  expectedDigest: string | null;
}

export function planModelArtifacts(input: {
  instances: readonly DedicatedServingInstance[];
  observations: readonly ArtifactObservation[];
  expectedDigests: Readonly<Record<string, string>>;
  mode: "real" | "mock";
  allowDownload: boolean;
}): { ok: boolean; reason: string | null; plans: ArtifactPlan[] } {
  const plans = input.instances.map((instance): ArtifactPlan => {
    const volume = `colony-model-${instance.endpointReference.slice("serving://".length)}`;
    if (input.mode === "mock") {
      return {
        instanceId: instance.instanceId,
        departmentId: instance.departmentId,
        modelVersion: instance.modelVersion,
        volume,
        action: "mock",
        expectedDigest: null,
      };
    }
    const expected = input.expectedDigests[instance.modelVersion] ?? input.expectedDigests[instance.instanceId] ?? null;
    const observed = input.observations.find((item) => item.instanceId === instance.instanceId);
    if (!expected) {
      return {
        instanceId: instance.instanceId,
        departmentId: instance.departmentId,
        modelVersion: instance.modelVersion,
        volume,
        action: "digest_unconfigured",
        expectedDigest: null,
      };
    }
    if (!observed || observed.recordedDigest === null) {
      return {
        instanceId: instance.instanceId,
        departmentId: instance.departmentId,
        modelVersion: instance.modelVersion,
        volume,
        action: "missing",
        expectedDigest: expected,
      };
    }
    if (observed.recordedDigest !== expected) {
      return {
        instanceId: instance.instanceId,
        departmentId: instance.departmentId,
        modelVersion: instance.modelVersion,
        volume,
        action: "mismatch",
        expectedDigest: expected,
      };
    }
    return {
      instanceId: instance.instanceId,
      departmentId: instance.departmentId,
      modelVersion: instance.modelVersion,
      volume,
      action: "reuse",
      expectedDigest: expected,
    };
  });
  const blocked = plans.filter((plan) => plan.action === "mismatch" || plan.action === "digest_unconfigured" || (plan.action === "missing" && !input.allowDownload));
  if (blocked.length > 0) {
    return {
      ok: false,
      reason: `Model provisioning failed closed: ${blocked.map((plan) => `${plan.volume}=${plan.action}`).join(", ")}. Unchanged artifacts are kept. Nothing is overwritten.`,
      plans,
    };
  }
  return { ok: true, reason: null, plans };
}
