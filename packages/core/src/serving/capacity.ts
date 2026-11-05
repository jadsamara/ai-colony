import type { DedicatedServingInstance } from "./types.js";

/** Planning figure for one Qwen3-8B weight set. This is not a measurement of a loaded process. */
const WEIGHT_BYTES_ESTIMATE = 5_200_000_000;
const KV_CACHE_BYTES_ESTIMATE = 512 * 1024 * 1024;
const SERVING_OVERHEAD_BYTES_ESTIMATE = 1_500_000_000;

export interface CapacityEstimate {
  kind: "estimate";
  measuredLoadedInstances: 0;
  instanceCount: number;
  weightBytesPerInstance: number;
  aggregateWeightBytes: number;
  kvCacheBytesPerRequest: number;
  servingOverheadBytes: number;
  aggregateResidentBytes: number;
  fitsOn24GbUnifiedMemory: false;
  pooledAcrossGpus: false;
  notes: string[];
}

export function estimateDedicatedCapacity(instanceCount: number): CapacityEstimate {
  const aggregateWeightBytes = WEIGHT_BYTES_ESTIMATE * instanceCount;
  const aggregateResidentBytes = instanceCount * (WEIGHT_BYTES_ESTIMATE + KV_CACHE_BYTES_ESTIMATE + SERVING_OVERHEAD_BYTES_ESTIMATE);
  return {
    kind: "estimate",
    measuredLoadedInstances: 0,
    instanceCount,
    weightBytesPerInstance: WEIGHT_BYTES_ESTIMATE,
    aggregateWeightBytes,
    kvCacheBytesPerRequest: KV_CACHE_BYTES_ESTIMATE,
    servingOverheadBytes: SERVING_OVERHEAD_BYTES_ESTIMATE,
    aggregateResidentBytes,
    fitsOn24GbUnifiedMemory: false,
    pooledAcrossGpus: false,
    notes: [
      "Weight size is a planning figure near 5.2 GB per Qwen3-8B instance, not a measurement taken while 12 processes were loaded.",
      "KV cache and serving overhead are estimates for one modest in-flight request. They grow with context and concurrency.",
      "GPU memory is not pooled across devices unless an explicit model-parallel deployment says so.",
      "Several dedicated processes may share one VM when that VM's memory can hold them. Twelve instances are not assumed to fit on one GPU.",
      "A 24 GB unified-memory laptop is not a host for twelve resident Qwen3-8B processes.",
    ],
  };
}

export interface GcpServicePlan {
  implementedInCode: true;
  provisioned: false;
  enablePaidResources: false;
  platform: "compute-engine";
  kubernetes: false;
  services: Array<{
    departmentId: string;
    agentId: string;
    instanceId: string;
    endpointReference: string;
    modelRegistryId: string;
    modelVersion: string;
    serviceAccount: string;
    scaling: { minInstances: 1; maxInstances: 1; replicasRequireExplicitConfig: true };
  }>;
}

export function gcpDeploymentPlan(instances: readonly DedicatedServingInstance[]): GcpServicePlan {
  return {
    implementedInCode: true,
    provisioned: false,
    enablePaidResources: false,
    platform: "compute-engine",
    kubernetes: false,
    services: instances.map((instance) => ({
      departmentId: instance.departmentId,
      agentId: instance.agentId,
      instanceId: instance.instanceId,
      endpointReference: instance.endpointReference,
      modelRegistryId: instance.modelRegistryId,
      modelVersion: instance.modelVersion,
      serviceAccount: `dept-${instance.endpointReference.slice("serving://".length)}@colony.iam`,
      scaling: { minInstances: 1, maxInstances: 1, replicasRequireExplicitConfig: true },
    })),
  };
}
