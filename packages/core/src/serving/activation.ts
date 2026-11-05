import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InferenceProvider } from "../inference/provider.js";
import { InferenceError } from "../inference/provider.js";
import type { RoutingSelection } from "../routing/types.js";
import { DEDICATED_SERVING_POLICY_VERSION, type DedicatedServingInstance } from "./types.js";

export interface DedicatedRoutingConfig {
  enabled: boolean;
  instances: readonly DedicatedServingInstance[];
  providerFor?: (instanceId: string) => InferenceProvider | null;
}

export interface ActivationRecord {
  enabled: boolean;
  policyVersion: string;
  activatedAt: string | null;
  instanceIds: string[];
  mode: "mock" | "real";
}

export function readActivation(path: string): ActivationRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ActivationRecord>;
    if (parsed.policyVersion !== DEDICATED_SERVING_POLICY_VERSION || typeof parsed.enabled !== "boolean") {
      return null;
    }
    return {
      enabled: parsed.enabled,
      policyVersion: parsed.policyVersion,
      activatedAt: typeof parsed.activatedAt === "string" ? parsed.activatedAt : null,
      instanceIds: Array.isArray(parsed.instanceIds) ? parsed.instanceIds.filter((id) => typeof id === "string") : [],
      mode: parsed.mode === "mock" ? "mock" : "real",
    };
  } catch {
    return null;
  }
}

export function writeActivationAtomic(path: string, record: ActivationRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, path);
}

export function dedicatedRoutingEnabled(env: NodeJS.ProcessEnv, record: ActivationRecord | null): boolean {
  return env.COLONY_DEDICATED_ROUTING === "on" && record?.enabled === true;
}

export function gateDedicatedExecution(
  decision: RoutingSelection | null,
  instances: readonly DedicatedServingInstance[],
  pinnedModelVersion: string | null,
): { ok: true; instanceId: string } | { ok: false; reason: string } {
  if (!decision || decision.authorization !== "authorized" || !decision.servingInstanceId) {
    return { ok: false, reason: "serving_migration_required" };
  }
  const live = instances.find((instance) => instance.instanceId === decision.servingInstanceId);
  if (!live || live.status !== "ready" || live.deploymentMode !== "dedicated") {
    return { ok: false, reason: "serving_instance_unavailable" };
  }
  if (decision.endpointReference && decision.endpointReference !== live.endpointReference) {
    return { ok: false, reason: "endpoint_override_denied" };
  }
  if (!pinnedModelVersion || pinnedModelVersion !== live.modelVersion) {
    return { ok: false, reason: "serving_migration_required" };
  }
  return { ok: true, instanceId: live.instanceId };
}

export function resolveDedicatedProvider(
  shared: InferenceProvider,
  servingInstanceId: string | null,
  routing: DedicatedRoutingConfig | undefined,
): InferenceProvider {
  if (!routing?.enabled) {
    return shared;
  }
  const bound = servingInstanceId && routing.providerFor ? routing.providerFor(servingInstanceId) : null;
  if (!bound) {
    throw new InferenceError("unavailable", "Dedicated routing refused the shared inference route", true);
  }
  return bound;
}

export async function probeServingEndpoint(origin: string, timeoutMs: number): Promise<boolean> {
  const root = origin.replace(/\/$/, "");
  for (const path of ["/api/version", "/v1/models", "/"]) {
    try {
      const response = await fetch(`${root}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}
