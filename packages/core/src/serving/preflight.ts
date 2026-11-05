import type { CapacityEstimate } from "./capacity.js";

export interface CapacityLimits {
  /** Operator-configured ceiling. This is not a measurement. */
  gpuVramBytes: number;
  hostRamBytes: number;
  diskBytes: number;
  /** Bytes reported by nvidia-smi, when the command succeeds. */
  measuredGpuVramBytes: number | null;
}

export interface PreflightResult {
  ok: boolean;
  reason: string | null;
  estimate: CapacityEstimate;
  limits: CapacityLimits;
}

export function assertDedicatedCapacity(
  estimate: CapacityEstimate,
  limits: CapacityLimits,
  mode: "real" | "mock",
): PreflightResult {
  if (mode === "mock") {
    return { ok: true, reason: null, estimate, limits };
  }
  if (limits.gpuVramBytes <= 0 && limits.hostRamBytes <= 0) {
    return {
      ok: false,
      reason: "Real model startup requires COLONY_GPU_VRAM_BYTES or COLONY_HOST_RAM_BYTES. Twelve Qwen3-8B processes are not assumed to fit on a 24 GB machine.",
      estimate,
      limits,
    };
  }
  const configured = Math.max(limits.gpuVramBytes, limits.hostRamBytes);
  if (estimate.aggregateResidentBytes > configured) {
    return {
      ok: false,
      reason: `Estimated resident memory ${estimate.aggregateResidentBytes} exceeds the configured capacity ${configured}.`,
      estimate,
      limits,
    };
  }
  if (limits.measuredGpuVramBytes !== null && estimate.aggregateResidentBytes > limits.measuredGpuVramBytes && limits.gpuVramBytes > 0) {
    return {
      ok: false,
      reason: `Estimated resident memory exceeds measured GPU VRAM ${limits.measuredGpuVramBytes}. GPU memory is not pooled across devices.`,
      estimate,
      limits,
    };
  }
  if (limits.diskBytes > 0 && estimate.aggregateWeightBytes > limits.diskBytes) {
    return {
      ok: false,
      reason: `Estimated model weight bytes exceed COLONY_MODEL_DISK_BYTES ${limits.diskBytes}.`,
      estimate,
      limits,
    };
  }
  return { ok: true, reason: null, estimate, limits };
}

export function limitsFromEnv(env: NodeJS.ProcessEnv, measuredGpuVramBytes: number | null): CapacityLimits {
  return {
    gpuVramBytes: numberFrom(env.COLONY_GPU_VRAM_BYTES),
    hostRamBytes: numberFrom(env.COLONY_HOST_RAM_BYTES),
    diskBytes: numberFrom(env.COLONY_MODEL_DISK_BYTES),
    measuredGpuVramBytes,
  };
}

function numberFrom(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
