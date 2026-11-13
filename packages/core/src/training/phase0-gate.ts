import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * C1.8D Phase 0 gate: autonomous training stays disabled until an operator
 * records a real GPU VM **v2.1** pass under thinking_disabled gating
 * (matched thinking_enabled eval is informational only).
 * Local smoke and superseded v1/v2-both-modes reports never unlock the scheduler.
 */
export const C18D_PHASE0_THRESHOLDS_VERSION = "c18d-phase0-thresholds-v2.1" as const;
export const C18D_PHASE0_THRESHOLDS_V2 = "c18d-phase0-thresholds-v2" as const;
export const C18D_PHASE0_THRESHOLDS_V1 = "c18d-phase0-thresholds-v1" as const;
export const C18D_AUTONOMOUS_TRAINING_FLAG = "c18d.autonomousTrainingEnabled" as const;

export type Phase0ThinkingModeId = "thinking_disabled" | "thinking_enabled";
export type Phase0EvalModeRole = "gating" | "informational";

export interface Phase0EvalMode {
  id: Phase0ThinkingModeId;
  role: Phase0EvalModeRole;
  enableThinking: boolean;
  maxNewTokens: number;
  extractAfterThink?: boolean;
}

export interface Phase0MemorizationThresholds {
  controlId: string;
  minExactMatchPerMode: number;
  minItems: number;
  requireAdapterLoaded: boolean;
  requireAdapterWeightDelta: boolean;
  evaluateBaseInBothModes: boolean;
}

export interface Phase0GeneralizationThresholds {
  controlId: string;
  minHeldoutExactMatchPerMode: number;
  minImprovementOverBasePerMode: number;
  minHeldoutItems: number;
  minTrainItems: number;
  requireAdapterLoaded: boolean;
  requireAdapterWeightDelta: boolean;
}

export interface Phase0Thresholds {
  specVersion: typeof C18D_PHASE0_THRESHOLDS_VERSION | string;
  declaredBeforeTraining: boolean;
  evaluation: {
    gatingMode: Phase0ThinkingModeId;
    modes: Phase0EvalMode[];
    maxBaseInvalidRate: number;
    maxBaseInvalidRateAppliesTo: "gatingMode";
    matchedSettingsRequired: boolean;
    invalidIsNotWrong: boolean;
  };
  memorization: Phase0MemorizationThresholds;
  generalization: Phase0GeneralizationThresholds;
  localSmoke: { modelId: string; countsAsPhase0Pass: false | boolean };
  gpuGate: {
    modelId: string;
    bothControlsMustPassInGatingMode: boolean;
    autonomousTrainingUnlocksOnlyAfterPass: boolean;
    requiredReportPath: string;
  };
}

export interface Phase0ControlEvidence {
  exactMatch?: number;
  heldoutExactMatch?: number;
  baseExactMatch?: number;
  sampleSize: number;
  adapterLoaded: boolean;
  adapterWeightsChanged: boolean;
  /** When set, base invalid rate must be ≤ maxBaseInvalidRate for a fair pass. */
  baseInvalidRate?: number;
  evaluationValid?: boolean;
}

export interface AutonomousLearningFlags {
  autonomousTrainingEnabled: boolean;
  phase0GpuPassRecorded: boolean;
  phase0ReportPath: string | null;
  thresholdsVersionRequired: typeof C18D_PHASE0_THRESHOLDS_VERSION;
  reason: string;
}

export const DEFAULT_PHASE0_THRESHOLDS: Phase0Thresholds = {
  specVersion: C18D_PHASE0_THRESHOLDS_VERSION,
  declaredBeforeTraining: true,
  evaluation: {
    gatingMode: "thinking_disabled",
    modes: [
      { id: "thinking_disabled", role: "gating", enableThinking: false, maxNewTokens: 64 },
      {
        id: "thinking_enabled",
        role: "informational",
        enableThinking: true,
        maxNewTokens: 4096,
        extractAfterThink: true,
      },
    ],
    maxBaseInvalidRate: 0.05,
    maxBaseInvalidRateAppliesTo: "gatingMode",
    matchedSettingsRequired: true,
    invalidIsNotWrong: true,
  },
  memorization: {
    controlId: "phase0-memorization-v1-dataset",
    minExactMatchPerMode: 0.95,
    minItems: 8,
    requireAdapterLoaded: true,
    requireAdapterWeightDelta: true,
    evaluateBaseInBothModes: true,
  },
  generalization: {
    controlId: "phase0-generalization-v2-hidden-reverse-suffix",
    minHeldoutExactMatchPerMode: 0.9,
    minImprovementOverBasePerMode: 0.5,
    minHeldoutItems: 100,
    minTrainItems: 200,
    requireAdapterLoaded: true,
    requireAdapterWeightDelta: true,
  },
  localSmoke: {
    modelId: "Qwen/Qwen3-0.6B",
    countsAsPhase0Pass: false,
  },
  gpuGate: {
    modelId: "Qwen/Qwen3-8B",
    bothControlsMustPassInGatingMode: true,
    autonomousTrainingUnlocksOnlyAfterPass: true,
    requiredReportPath: "docs/milestones/C1_8D_PHASE0_GPU_RESULT_V2.json",
  },
};

/** Historical v2 thresholds (both modes gated). Superseded by v2.1. */
export const PHASE0_THRESHOLDS_V2_HISTORICAL = {
  specVersion: C18D_PHASE0_THRESHOLDS_V2,
  status: "superseded" as const,
  note: "Required both thinking modes to pass. Superseded because adapters train with enable_thinking=False; thinking_enabled eval is OOD for the gate.",
};

/** Legacy v1 thresholds retained for historical comparison only. */
export const PHASE0_THRESHOLDS_V1_HISTORICAL = {
  specVersion: C18D_PHASE0_THRESHOLDS_V1,
  memorization: { minExactMatch: 0.95, minItems: 8 },
  generalization: { minHeldoutExactMatch: 0.9, minImprovementOverBase: 0.5, minHeldoutItems: 20 },
  status: "superseded" as const,
};

export function judgeMemorizationControl(
  evidence: Phase0ControlEvidence,
  thresholds: Phase0MemorizationThresholds = DEFAULT_PHASE0_THRESHOLDS.memorization,
  evaluation = DEFAULT_PHASE0_THRESHOLDS.evaluation,
): { passed: boolean; checks: Record<string, boolean> } {
  const exact = evidence.exactMatch ?? 0;
  const invalidRate = evidence.baseInvalidRate ?? 0;
  const evaluationValid = evidence.evaluationValid
    ?? invalidRate <= evaluation.maxBaseInvalidRate;
  const checks = {
    evaluationValid,
    exactMatchPass: exact >= thresholds.minExactMatchPerMode,
    adapterLoaded: !thresholds.requireAdapterLoaded || evidence.adapterLoaded,
    adapterWeightDelta: !thresholds.requireAdapterWeightDelta || evidence.adapterWeightsChanged,
    sampleSizeOk: evidence.sampleSize >= thresholds.minItems,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export function judgeGeneralizationControl(
  evidence: Phase0ControlEvidence,
  thresholds: Phase0GeneralizationThresholds = DEFAULT_PHASE0_THRESHOLDS.generalization,
  evaluation = DEFAULT_PHASE0_THRESHOLDS.evaluation,
): { passed: boolean; checks: Record<string, boolean>; improvement: number } {
  const heldout = evidence.heldoutExactMatch ?? evidence.exactMatch ?? 0;
  const base = evidence.baseExactMatch ?? 0;
  const improvement = heldout - base;
  const invalidRate = evidence.baseInvalidRate ?? 0;
  const evaluationValid = evidence.evaluationValid
    ?? invalidRate <= evaluation.maxBaseInvalidRate;
  const checks = {
    evaluationValid,
    heldoutExactMatchPass: heldout >= thresholds.minHeldoutExactMatchPerMode,
    improvementPass: improvement >= thresholds.minImprovementOverBasePerMode,
    adapterLoaded: !thresholds.requireAdapterLoaded || evidence.adapterLoaded,
    adapterWeightDelta: !thresholds.requireAdapterWeightDelta || evidence.adapterWeightsChanged,
    sampleSizeOk: evidence.sampleSize >= thresholds.minHeldoutItems,
  };
  return { passed: Object.values(checks).every(Boolean), checks, improvement };
}

export function classifyPredictionOutcome(input: {
  exactMatch: boolean;
  invalid: boolean;
}): "correct" | "wrong" | "invalid" {
  if (input.invalid) {
    return "invalid";
  }
  return input.exactMatch ? "correct" : "wrong";
}

export function evaluationValidity(input: {
  invalidRate: number;
  maxBaseInvalidRate?: number;
}): { evaluationValid: boolean; maxBaseInvalidRate: number } {
  const maxBaseInvalidRate = input.maxBaseInvalidRate
    ?? DEFAULT_PHASE0_THRESHOLDS.evaluation.maxBaseInvalidRate;
  return {
    evaluationValid: input.invalidRate <= maxBaseInvalidRate,
    maxBaseInvalidRate,
  };
}

/**
 * Autonomous training unlocks only from a non-superseded GPU v2.1 pass report.
 */
export function readAutonomousLearningFlags(input?: {
  reportPath?: string | null;
  supersededPath?: string | null;
  repoRoot?: string;
}): AutonomousLearningFlags {
  const repoRoot = input?.repoRoot;
  const supersededPath = input?.supersededPath
    ?? (repoRoot ? resolve(repoRoot, "docs/milestones/C1_8D_PHASE0_V1_SUPERSEDED.json") : null);
  const reportPath = input?.reportPath
    ?? (repoRoot
      ? resolve(repoRoot, DEFAULT_PHASE0_THRESHOLDS.gpuGate.requiredReportPath)
      : null);

  if (supersededPath && existsSync(supersededPath)) {
    try {
      const superseded = JSON.parse(readFileSync(supersededPath, "utf8")) as {
        status?: string;
        autonomousTrainingUnlocked?: boolean;
      };
      if (superseded.status === "superseded" && superseded.autonomousTrainingUnlocked === false) {
        // Continue — v1 is locked; still check for a v2.1 pass below.
      }
    } catch {
      // Ignore unreadable supersession marker; fail closed via missing v2.1 report.
    }
  }

  if (!reportPath || !existsSync(reportPath)) {
    return {
      autonomousTrainingEnabled: false,
      phase0GpuPassRecorded: false,
      phase0ReportPath: reportPath,
      thresholdsVersionRequired: C18D_PHASE0_THRESHOLDS_VERSION,
      reason: "No GPU Phase 0 v2.1 pass report recorded; autonomous training remains disabled",
    };
  }

  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      mode?: string;
      status?: string;
      phase0Passed?: boolean;
      countsAsPhase0Pass?: boolean;
      thresholdsVersion?: string;
      autonomousTrainingUnlocked?: boolean;
      specVersion?: string;
    };
    if (report.status === "superseded") {
      return {
        autonomousTrainingEnabled: false,
        phase0GpuPassRecorded: false,
        phase0ReportPath: reportPath,
        thresholdsVersionRequired: C18D_PHASE0_THRESHOLDS_VERSION,
        reason: "Phase 0 report is marked superseded; autonomous training remains disabled",
      };
    }
    const ok = report.mode === "gpu-controls-v2"
      && report.phase0Passed === true
      && report.countsAsPhase0Pass !== false
      && report.thresholdsVersion === C18D_PHASE0_THRESHOLDS_VERSION
      && report.autonomousTrainingUnlocked === true;
    return {
      autonomousTrainingEnabled: ok,
      phase0GpuPassRecorded: ok,
      phase0ReportPath: reportPath,
      thresholdsVersionRequired: C18D_PHASE0_THRESHOLDS_VERSION,
      reason: ok
        ? "GPU Phase 0 v2.1 pass report present"
        : "Phase 0 report present but does not satisfy v2.1 unlock requirements",
    };
  } catch (error) {
    return {
      autonomousTrainingEnabled: false,
      phase0GpuPassRecorded: false,
      phase0ReportPath: reportPath,
      thresholdsVersionRequired: C18D_PHASE0_THRESHOLDS_VERSION,
      reason: `Phase 0 report unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function assertAutonomousTrainingAllowed(
  flags: AutonomousLearningFlags = readAutonomousLearningFlags(),
): void {
  if (!flags.autonomousTrainingEnabled) {
    throw new Error(`Autonomous training disabled: ${flags.reason}`);
  }
}
