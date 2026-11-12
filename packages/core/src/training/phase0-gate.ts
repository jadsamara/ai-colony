import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * C1.8D Phase 0 gate: autonomous training stays disabled until an operator
 * records a real GPU VM pass. Local smoke never unlocks the scheduler.
 */
export const C18D_PHASE0_THRESHOLDS_VERSION = "c18d-phase0-thresholds-v1" as const;
export const C18D_AUTONOMOUS_TRAINING_FLAG = "c18d.autonomousTrainingEnabled" as const;

export interface Phase0MemorizationThresholds {
  controlId: string;
  minExactMatch: number;
  minItems: number;
  requireAdapterLoaded: boolean;
  requireAdapterWeightDelta: boolean;
}

export interface Phase0GeneralizationThresholds {
  controlId: string;
  minHeldoutExactMatch: number;
  minImprovementOverBase: number;
  minHeldoutItems: number;
  requireAdapterLoaded: boolean;
  requireAdapterWeightDelta: boolean;
}

export interface Phase0Thresholds {
  specVersion: typeof C18D_PHASE0_THRESHOLDS_VERSION | string;
  declaredBeforeTraining: boolean;
  memorization: Phase0MemorizationThresholds;
  generalization: Phase0GeneralizationThresholds;
  localSmoke: { modelId: string; countsAsPhase0Pass: false | boolean; purpose: string };
  gpuGate: {
    modelId: string;
    bothControlsMustPass: boolean;
    autonomousTrainingUnlocksOnlyAfterPass: boolean;
  };
}

export interface Phase0ControlEvidence {
  exactMatch?: number;
  heldoutExactMatch?: number;
  baseExactMatch?: number;
  sampleSize: number;
  adapterLoaded: boolean;
  adapterWeightsChanged: boolean;
}

export interface AutonomousLearningFlags {
  /** Hard gate — must remain false until GPU Phase 0 pass is recorded. */
  autonomousTrainingEnabled: boolean;
  phase0GpuPassRecorded: boolean;
  phase0ReportPath: string | null;
  reason: string;
}

export const DEFAULT_PHASE0_THRESHOLDS: Phase0Thresholds = {
  specVersion: C18D_PHASE0_THRESHOLDS_VERSION,
  declaredBeforeTraining: true,
  memorization: {
    controlId: "phase0-memorization-v1",
    minExactMatch: 0.95,
    minItems: 8,
    requireAdapterLoaded: true,
    requireAdapterWeightDelta: true,
  },
  generalization: {
    controlId: "phase0-generalization-v1",
    minHeldoutExactMatch: 0.9,
    minImprovementOverBase: 0.5,
    minHeldoutItems: 20,
    requireAdapterLoaded: true,
    requireAdapterWeightDelta: true,
  },
  localSmoke: {
    modelId: "Qwen/Qwen3-0.6B",
    countsAsPhase0Pass: false,
    purpose: "Catch chat-template / masking / adapter-load bugs before GPU spend",
  },
  gpuGate: {
    modelId: "Qwen/Qwen3-8B",
    bothControlsMustPass: true,
    autonomousTrainingUnlocksOnlyAfterPass: true,
  },
};

export function judgeMemorizationControl(
  evidence: Phase0ControlEvidence,
  thresholds: Phase0MemorizationThresholds = DEFAULT_PHASE0_THRESHOLDS.memorization,
): { passed: boolean; checks: Record<string, boolean> } {
  const exact = evidence.exactMatch ?? 0;
  const checks = {
    exactMatchPass: exact >= thresholds.minExactMatch,
    adapterLoaded: !thresholds.requireAdapterLoaded || evidence.adapterLoaded,
    adapterWeightDelta: !thresholds.requireAdapterWeightDelta || evidence.adapterWeightsChanged,
    sampleSizeOk: evidence.sampleSize >= thresholds.minItems,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export function judgeGeneralizationControl(
  evidence: Phase0ControlEvidence,
  thresholds: Phase0GeneralizationThresholds = DEFAULT_PHASE0_THRESHOLDS.generalization,
): { passed: boolean; checks: Record<string, boolean>; improvement: number } {
  const heldout = evidence.heldoutExactMatch ?? evidence.exactMatch ?? 0;
  const base = evidence.baseExactMatch ?? 0;
  const improvement = heldout - base;
  const checks = {
    heldoutExactMatchPass: heldout >= thresholds.minHeldoutExactMatch,
    improvementPass: improvement >= thresholds.minImprovementOverBase,
    adapterLoaded: !thresholds.requireAdapterLoaded || evidence.adapterLoaded,
    adapterWeightDelta: !thresholds.requireAdapterWeightDelta || evidence.adapterWeightsChanged,
    sampleSizeOk: evidence.sampleSize >= thresholds.minHeldoutItems,
  };
  return { passed: Object.values(checks).every(Boolean), checks, improvement };
}

/**
 * Autonomous training is disabled unless an operator-supplied GPU Phase 0
 * report exists and records phase0Passed=true for gpu-controls mode.
 */
export function readAutonomousLearningFlags(input?: {
  reportPath?: string | null;
  repoRoot?: string;
}): AutonomousLearningFlags {
  const reportPath = input?.reportPath
    ?? (input?.repoRoot
      ? resolve(input.repoRoot, "docs/milestones/C1_8D_PHASE0_GPU_RESULT.json")
      : null);
  if (!reportPath || !existsSync(reportPath)) {
    return {
      autonomousTrainingEnabled: false,
      phase0GpuPassRecorded: false,
      phase0ReportPath: reportPath,
      reason: "No GPU Phase 0 pass report recorded; autonomous training remains disabled",
    };
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      mode?: string;
      phase0Passed?: boolean;
      countsAsPhase0Pass?: boolean;
    };
    const ok = report.mode === "gpu-controls"
      && report.phase0Passed === true
      && report.countsAsPhase0Pass !== false;
    return {
      autonomousTrainingEnabled: ok,
      phase0GpuPassRecorded: ok,
      phase0ReportPath: reportPath,
      reason: ok
        ? "GPU Phase 0 pass report present"
        : "Phase 0 report present but does not unlock autonomous training",
    };
  } catch (error) {
    return {
      autonomousTrainingEnabled: false,
      phase0GpuPassRecorded: false,
      phase0ReportPath: reportPath,
      reason: `Phase 0 report unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function assertAutonomousTrainingAllowed(flags: AutonomousLearningFlags = readAutonomousLearningFlags()): void {
  if (!flags.autonomousTrainingEnabled) {
    throw new Error(`Autonomous training disabled: ${flags.reason}`);
  }
}
