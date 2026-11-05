import { DomainError } from "../errors/domain-error.js";
import { normalizeEndpoint } from "./endpoints.js";
import type { DedicatedServingInstance } from "./types.js";

export interface TrustedEndpointDirectory {
  resolve(endpointReference: string): string;
}

export function bindDedicatedEndpoints(
  instances: readonly DedicatedServingInstance[],
  directory: TrustedEndpointDirectory,
): DedicatedServingInstance[] {
  const seenInstances = new Set<string>();
  const seenDepartments = new Set<string>();
  const seenEndpoints = new Map<string, string>();
  return instances.map((instance) => {
    if (instance.deploymentMode !== "dedicated") {
      throw new DomainError("SERVING_NOT_DEDICATED", "Department serving must be dedicated", 409);
    }
    if (seenInstances.has(instance.instanceId)) {
      throw new DomainError("SERVING_INSTANCE_SHARED", "Serving instance identity is already assigned", 409);
    }
    if (seenDepartments.has(instance.departmentId)) {
      throw new DomainError("SERVING_INSTANCE_SHARED", "Department already has a serving instance", 409);
    }
    const resolved = directory.resolve(instance.endpointReference);
    const normalized = normalizeEndpoint(resolved);
    const owner = seenEndpoints.get(normalized);
    if (owner) {
      throw new DomainError("SERVING_ENDPOINT_SHARED", `Endpoint already serves ${owner}`, 409, {
        endpoint: normalized,
      });
    }
    seenInstances.add(instance.instanceId);
    seenDepartments.add(instance.departmentId);
    seenEndpoints.set(normalized, instance.departmentId);
    return { ...instance, normalizedEndpoint: normalized };
  });
}

export function assertNoSharedServing(instances: readonly DedicatedServingInstance[]): void {
  bindDedicatedEndpoints(instances, {
    resolve(reference) {
      const instance = instances.find((candidate) => candidate.endpointReference === reference);
      if (!instance) {
        throw new DomainError("SERVING_ENDPOINT_UNKNOWN", "Serving reference is not in the trusted plan", 404);
      }
      return instance.normalizedEndpoint.startsWith("serving://")
        ? `http://dedicated.invalid/${reference.slice("serving://".length)}`
        : instance.normalizedEndpoint;
    },
  });
}
