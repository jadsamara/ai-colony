import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * C1.8D Phase 0 gate: autonomous training stays disabled until an operator
 * records a real GPU VM **v3** pass whose evidence independently satisfies
 * conservative-bound checks. Report-supplied booleans alone never unlock.
 */
export const C18D_PHASE0_THRESHOLDS_VERSION = "c18d-phase0-thresholds-v3" as const;
export const C18D_PHASE0_THRESHOLDS_V2_1 = "c18d-phase0-thresholds-v2.1" as const;
export const C18D_PHASE0_THRESHOLDS_V2 = "c18d-phase0-thresholds-v2" as const;
export const C18D_PHASE0_THRESHOLDS_V1 = "c18d-phase0-thresholds-v1" as const;
export const C18D_AUTONOMOUS_TRAINING_FLAG = "c18d.autonomousTrainingEnabled" as const;
export const C18D_PHASE0_GPU_REPORT_MODE = "gpu-controls-v3" as const;

export type Phase0ThinkingModeId = "thinking_disabled" | "thinking_enabled";
export type Phase0EvalModeRole = "gating" | "informational";

export interface Phase0EvalMode {
  id: Phase0ThinkingModeId;
  role: Phase0EvalModeRole;
  enableThinking: boolean;
  maxNewTokens: number;
  extractAfterThink?: boolean;
  defaultSkipOnGpuControls?: boolean;
}

export interface Phase0MemorizationThresholds {
  controlId: string;
  minAdapterLowerBoundAccuracy: number;
  minItems: number;
  requireAdapterLoaded: boolean;
  requireAdapterWeightDelta: boolean;
  requireImprovementOverBase: false | boolean;
}

export interface Phase0GeneralizationThresholds {
  controlId: string;
  minAdapterLowerBoundAccuracy: number;
  minConservativeImprovementOverBase: number;
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
    comparisonMethod: "conservative_worst_case_bounds";
    modes: Phase0EvalMode[];
    matchedSettingsRequired: boolean;
    invalidIsNotWrong: boolean;
    hardBaseInvalidRateCutoff: false | boolean;
  };
  memorization: Phase0MemorizationThresholds;
  generalization: Phase0GeneralizationThresholds;
  localSmoke: { modelId: string; countsAsPhase0Pass: false | boolean };
  gpuGate: {
    modelId: string;
    bothControlsMustPassInGatingMode: boolean;
    skipThinkingEnabledByDefault: boolean;
    freshAdaptersRequired: boolean;
    reusePriorAdapters: boolean;
    autonomousTrainingUnlocksOnlyAfterIndependentEvidencePass: boolean;
    requiredReportPath: string;
    requiredReportMode: typeof C18D_PHASE0_GPU_REPORT_MODE | string;
  };
}

export interface Phase0CountEvidence {
  correct: number;
  wrong: number;
  invalid: number;
  sampleSize?: number;
}

export interface Phase0ControlEvidence {
  exactMatch?: number;
  heldoutExactMatch?: number;
  baseExactMatch?: number;
  sampleSize: number;
  adapterLoaded: boolean;
  adapterWeightsChanged: boolean;
  /** Legacy v2/v2.1 fields — unused by v3 gate. */
  baseInvalidRate?: number;
  evaluationValid?: boolean;
  /** v3 conservative-bound fields */
  baseCorrect?: number;
  baseWrong?: number;
  baseInvalid?: number;
  adapterCorrect?: number;
  adapterWrong?: number;
  adapterInvalid?: number;
  adapterLowerBoundAccuracy?: number;
  baseUpperBoundAccuracy?: number;
  conservativeImprovement?: number;
  observedAdapterAccuracy?: number;
  observedBaseAccuracy?: number;
}

export interface AutonomousLearningFlags {
  autonomousTrainingEnabled: boolean;
  phase0GpuPassRecorded: boolean;
  phase0ReportPath: string | null;
  thresholdsVersionRequired: typeof C18D_PHASE0_THRESHOLDS_VERSION;
  reason: string;
  independentChecks?: Record<string, boolean>;
}

export const DEFAULT_PHASE0_THRESHOLDS: Phase0Thresholds = {
  specVersion: C18D_PHASE0_THRESHOLDS_VERSION,
  declaredBeforeTraining: false,
  evaluation: {
    gatingMode: "thinking_disabled",
    comparisonMethod: "conservative_worst_case_bounds",
    modes: [
      { id: "thinking_disabled", role: "gating", enableThinking: false, maxNewTokens: 256 },
      {
        id: "thinking_enabled",
        role: "informational",
        enableThinking: true,
        maxNewTokens: 4096,
        extractAfterThink: true,
        defaultSkipOnGpuControls: true,
      },
    ],
    matchedSettingsRequired: true,
    invalidIsNotWrong: true,
    hardBaseInvalidRateCutoff: false,
  },
  memorization: {
    controlId: "phase0-memorization-v1-dataset",
    minAdapterLowerBoundAccuracy: 0.95,
    minItems: 8,
    requireAdapterLoaded: true,
    requireAdapterWeightDelta: true,
    requireImprovementOverBase: false,
  },
  generalization: {
    controlId: "phase0-generalization-v2-hidden-reverse-suffix",
    minAdapterLowerBoundAccuracy: 0.9,
    minConservativeImprovementOverBase: 0.5,
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
    skipThinkingEnabledByDefault: true,
    freshAdaptersRequired: true,
    reusePriorAdapters: false,
    autonomousTrainingUnlocksOnlyAfterIndependentEvidencePass: true,
    requiredReportPath: "docs/milestones/C1_8D_PHASE0_GPU_RESULT_V3.json",
    requiredReportMode: C18D_PHASE0_GPU_REPORT_MODE,
  },
};

/** Historical v2.1 thresholds. Superseded by v3 after examining the v2.1 GPU failure mode. */
export const PHASE0_THRESHOLDS_V2_1_HISTORICAL = {
  specVersion: C18D_PHASE0_THRESHOLDS_V2_1,
  status: "superseded" as const,
  note: "Hard base invalid-rate cutoff rejected otherwise-strong adapter runs. Superseded by v3 conservative bounds.",
};

/** Historical v2 thresholds (both modes gated). */
export const PHASE0_THRESHOLDS_V2_HISTORICAL = {
  specVersion: C18D_PHASE0_THRESHOLDS_V2,
  status: "superseded" as const,
  note: "Required both thinking modes to pass. Superseded by v2.1 then v3.",
};

/** Legacy v1 thresholds retained for historical comparison only. */
export const PHASE0_THRESHOLDS_V1_HISTORICAL = {
  specVersion: C18D_PHASE0_THRESHOLDS_V1,
  memorization: { minExactMatch: 0.95, minItems: 8 },
  generalization: { minHeldoutExactMatch: 0.9, minImprovementOverBase: 0.5, minHeldoutItems: 20 },
  status: "superseded" as const,
};

export function computeConservativeAccuracyBounds(input: Phase0CountEvidence): {
  total: number;
  correct: number;
  wrong: number;
  invalid: number;
  countsConsistent: boolean;
  observedAccuracy: number;
  upperBoundAccuracy: number;
  lowerBoundAccuracy: number;
} {
  const correct = input.correct;
  const wrong = input.wrong;
  const invalid = input.invalid;
  const total = correct + wrong + invalid;
  const declared = input.sampleSize;
  const countsConsistent = declared === undefined || declared === total;
  return {
    total,
    correct,
    wrong,
    invalid,
    countsConsistent,
    observedAccuracy: total ? correct / total : 0,
    upperBoundAccuracy: total ? (correct + invalid) / total : 0,
    lowerBoundAccuracy: total ? correct / total : 0,
  };
}

export function computeConservativeImprovement(input: {
  base: Phase0CountEvidence;
  adapter: Phase0CountEvidence;
}): {
  baseUpperBoundAccuracy: number;
  adapterLowerBoundAccuracy: number;
  conservativeImprovement: number;
  observedImprovement: number;
  countsConsistent: boolean;
} {
  const base = computeConservativeAccuracyBounds(input.base);
  const adapter = computeConservativeAccuracyBounds(input.adapter);
  return {
    baseUpperBoundAccuracy: base.upperBoundAccuracy,
    adapterLowerBoundAccuracy: adapter.lowerBoundAccuracy,
    conservativeImprovement: adapter.lowerBoundAccuracy - base.upperBoundAccuracy,
    observedImprovement: adapter.observedAccuracy - base.observedAccuracy,
    countsConsistent: base.countsConsistent && adapter.countsConsistent,
  };
}

function resolveCountEvidence(evidence: Phase0ControlEvidence, side: "base" | "adapter"): Phase0CountEvidence | null {
  if (side === "base") {
    if (
      evidence.baseCorrect === undefined
      || evidence.baseWrong === undefined
      || evidence.baseInvalid === undefined
    ) {
      return null;
    }
    return {
      correct: evidence.baseCorrect,
      wrong: evidence.baseWrong,
      invalid: evidence.baseInvalid,
      sampleSize: evidence.sampleSize,
    };
  }
  if (
    evidence.adapterCorrect === undefined
    || evidence.adapterWrong === undefined
    || evidence.adapterInvalid === undefined
  ) {
    return null;
  }
  return {
    correct: evidence.adapterCorrect,
    wrong: evidence.adapterWrong,
    invalid: evidence.adapterInvalid,
    sampleSize: evidence.sampleSize,
  };
}

export function judgeMemorizationControl(
  evidence: Phase0ControlEvidence,
  thresholds: Phase0MemorizationThresholds = DEFAULT_PHASE0_THRESHOLDS.memorization,
): { passed: boolean; checks: Record<string, boolean>; bounds?: ReturnType<typeof computeConservativeAccuracyBounds> } {
  const adapterCounts = resolveCountEvidence(evidence, "adapter");
  const bounds = adapterCounts
    ? computeConservativeAccuracyBounds(adapterCounts)
    : null;
  const lower = bounds?.lowerBoundAccuracy
    ?? evidence.adapterLowerBoundAccuracy
    ?? evidence.exactMatch
    ?? 0;
  const checks: Record<string, boolean> = {
    countsPresent: adapterCounts !== null || evidence.adapterLowerBoundAccuracy !== undefined || evidence.exactMatch !== undefined,
    countsConsistent: bounds?.countsConsistent ?? true,
    adapterLowerBoundPass: lower >= thresholds.minAdapterLowerBoundAccuracy,
    adapterLoaded: !thresholds.requireAdapterLoaded || evidence.adapterLoaded,
    adapterWeightDelta: !thresholds.requireAdapterWeightDelta || evidence.adapterWeightsChanged,
    sampleSizeOk: evidence.sampleSize >= thresholds.minItems,
  };
  if (thresholds.requireImprovementOverBase) {
    const baseCounts = resolveCountEvidence(evidence, "base");
    if (adapterCounts && baseCounts) {
      const improvement = computeConservativeImprovement({ base: baseCounts, adapter: adapterCounts });
      checks.improvementPass = improvement.conservativeImprovement >= 0;
    } else {
      checks.improvementPass = false;
    }
  }
  return { passed: Object.values(checks).every(Boolean), checks, bounds: bounds ?? undefined };
}

export function judgeGeneralizationControl(
  evidence: Phase0ControlEvidence,
  thresholds: Phase0GeneralizationThresholds = DEFAULT_PHASE0_THRESHOLDS.generalization,
): {
  passed: boolean;
  checks: Record<string, boolean>;
  improvement: number;
  bounds?: ReturnType<typeof computeConservativeImprovement>;
} {
  const baseCounts = resolveCountEvidence(evidence, "base");
  const adapterCounts = resolveCountEvidence(evidence, "adapter");
  let improvementMeta: ReturnType<typeof computeConservativeImprovement> | null = null;
  if (baseCounts && adapterCounts) {
    improvementMeta = computeConservativeImprovement({ base: baseCounts, adapter: adapterCounts });
  }
  const adapterLower = improvementMeta?.adapterLowerBoundAccuracy
    ?? evidence.adapterLowerBoundAccuracy
    ?? evidence.heldoutExactMatch
    ?? evidence.exactMatch
    ?? 0;
  const conservativeImprovement = improvementMeta?.conservativeImprovement
    ?? evidence.conservativeImprovement
    ?? (
      (evidence.adapterLowerBoundAccuracy ?? evidence.heldoutExactMatch ?? evidence.exactMatch ?? 0)
      - (evidence.baseUpperBoundAccuracy ?? evidence.baseExactMatch ?? 0)
    );
  const checks = {
    countsPresent: Boolean(baseCounts && adapterCounts)
      || (evidence.adapterLowerBoundAccuracy !== undefined && evidence.baseUpperBoundAccuracy !== undefined),
    countsConsistent: improvementMeta?.countsConsistent ?? true,
    heldoutLowerBoundPass: adapterLower >= thresholds.minAdapterLowerBoundAccuracy,
    conservativeImprovementPass: conservativeImprovement >= thresholds.minConservativeImprovementOverBase,
    adapterLoaded: !thresholds.requireAdapterLoaded || evidence.adapterLoaded,
    adapterWeightDelta: !thresholds.requireAdapterWeightDelta || evidence.adapterWeightsChanged,
    sampleSizeOk: evidence.sampleSize >= thresholds.minHeldoutItems,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    improvement: conservativeImprovement,
    bounds: improvementMeta ?? undefined,
  };
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

/** Legacy helper retained for older diagnostics; v3 does not gate on this. */
export function evaluationValidity(input: {
  invalidRate: number;
  maxBaseInvalidRate?: number;
}): { evaluationValid: boolean; maxBaseInvalidRate: number } {
  const maxBaseInvalidRate = input.maxBaseInvalidRate ?? 0.05;
  return {
    evaluationValid: input.invalidRate <= maxBaseInvalidRate,
    maxBaseInvalidRate,
  };
}

type RawPhase0Report = {
  mode?: string;
  status?: string;
  phase0Passed?: boolean;
  countsAsPhase0Pass?: boolean;
  thresholdsVersion?: string;
  autonomousTrainingUnlocked?: boolean;
  gatingMode?: string;
  thinkingEnabledSkipped?: boolean;
  memorization?: {
    passedInGatingMode?: boolean;
    gatingMode?: {
      thinkingMode?: string;
      affectsGate?: boolean;
      checks?: Record<string, boolean>;
      sampleSize?: number;
      base?: Phase0CountEvidence & { upperBoundAccuracy?: number; observedAccuracy?: number };
      adapter?: Phase0CountEvidence & { lowerBoundAccuracy?: number; observedAccuracy?: number };
      adapterLoaded?: boolean;
      adapterWeightsChanged?: boolean;
      baseUpperBoundAccuracy?: number;
      adapterLowerBoundAccuracy?: number;
      conservativeImprovement?: number;
      observedAdapterAccuracy?: number;
      observedBaseAccuracy?: number;
    };
  };
  generalization?: {
    passedInGatingMode?: boolean;
    gatingMode?: {
      thinkingMode?: string;
      affectsGate?: boolean;
      checks?: Record<string, boolean>;
      sampleSize?: number;
      base?: Phase0CountEvidence & { upperBoundAccuracy?: number; observedAccuracy?: number };
      adapter?: Phase0CountEvidence & { lowerBoundAccuracy?: number; observedAccuracy?: number };
      adapterLoaded?: boolean;
      adapterWeightsChanged?: boolean;
      baseUpperBoundAccuracy?: number;
      adapterLowerBoundAccuracy?: number;
      conservativeImprovement?: number;
      observedAdapterAccuracy?: number;
      observedBaseAccuracy?: number;
    };
  };
};

function evidenceFromGatingRow(row: NonNullable<RawPhase0Report["memorization"]>["gatingMode"]): Phase0ControlEvidence | null {
  if (!row) {
    return null;
  }
  const base = row.base;
  const adapter = row.adapter;
  if (!base || !adapter) {
    return null;
  }
  return {
    sampleSize: row.sampleSize ?? adapter.sampleSize ?? (adapter.correct + adapter.wrong + adapter.invalid),
    adapterLoaded: Boolean(row.adapterLoaded),
    adapterWeightsChanged: Boolean(row.adapterWeightsChanged),
    baseCorrect: base.correct,
    baseWrong: base.wrong,
    baseInvalid: base.invalid,
    adapterCorrect: adapter.correct,
    adapterWrong: adapter.wrong,
    adapterInvalid: adapter.invalid,
    baseUpperBoundAccuracy: row.baseUpperBoundAccuracy,
    adapterLowerBoundAccuracy: row.adapterLowerBoundAccuracy,
    conservativeImprovement: row.conservativeImprovement,
    observedAdapterAccuracy: row.observedAdapterAccuracy,
    observedBaseAccuracy: row.observedBaseAccuracy,
  };
}

/**
 * Independently re-validate a Phase 0 v3 GPU report from recorded counts.
 * Report-supplied `phase0Passed` / `autonomousTrainingUnlocked` are ignored.
 */
export function validatePhase0V3GpuReport(report: unknown): {
  passed: boolean;
  checks: Record<string, boolean>;
  reason: string;
  memorization?: ReturnType<typeof judgeMemorizationControl>;
  generalization?: ReturnType<typeof judgeGeneralizationControl>;
} {
  const raw = (report ?? {}) as RawPhase0Report;
  const headerChecks = {
    thresholdsVersion: raw.thresholdsVersion === C18D_PHASE0_THRESHOLDS_VERSION,
    reportMode: raw.mode === C18D_PHASE0_GPU_REPORT_MODE,
    notSuperseded: raw.status !== "superseded",
    gatingMode: raw.gatingMode === DEFAULT_PHASE0_THRESHOLDS.evaluation.gatingMode,
    countsAsPhase0PassMatchesComputed: true, // filled after control checks
  };

  const memRow = raw.memorization?.gatingMode;
  const genRow = raw.generalization?.gatingMode;
  const memEvidence = evidenceFromGatingRow(memRow);
  const genEvidence = evidenceFromGatingRow(genRow);

  const modeChecks = {
    memorizationGatingMode: memRow?.thinkingMode === "thinking_disabled" && memRow?.affectsGate === true,
    generalizationGatingMode: genRow?.thinkingMode === "thinking_disabled" && genRow?.affectsGate === true,
    memorizationEvidencePresent: memEvidence !== null,
    generalizationEvidencePresent: genEvidence !== null,
  };

  if (!memEvidence || !genEvidence) {
    const checks = { ...headerChecks, ...modeChecks, evidenceComplete: false };
    return {
      passed: false,
      checks,
      reason: "Phase 0 v3 report missing complete gating-mode count evidence",
    };
  }

  const memorization = judgeMemorizationControl(memEvidence);
  const generalization = judgeGeneralizationControl(genEvidence);

  // Cross-check reported bounds against recomputed values when both are present.
  const recomputedMemLower = memorization.bounds?.lowerBoundAccuracy;
  const recomputedGen = generalization.bounds;
  const consistency = {
    memorizationBoundConsistent: recomputedMemLower === undefined
      || memRow?.adapterLowerBoundAccuracy === undefined
      || Math.abs(recomputedMemLower - memRow.adapterLowerBoundAccuracy) < 1e-9,
    generalizationBoundConsistent: recomputedGen === undefined
      || genRow === undefined
      || (
        (genRow.adapterLowerBoundAccuracy === undefined
          || Math.abs(recomputedGen.adapterLowerBoundAccuracy - genRow.adapterLowerBoundAccuracy) < 1e-9)
        && (genRow.baseUpperBoundAccuracy === undefined
          || Math.abs(recomputedGen.baseUpperBoundAccuracy - genRow.baseUpperBoundAccuracy) < 1e-9)
        && (genRow.conservativeImprovement === undefined
          || Math.abs(recomputedGen.conservativeImprovement - genRow.conservativeImprovement) < 1e-9)
      ),
  };

  const computedPass = memorization.passed
    && generalization.passed
    && Object.values(headerChecks).every(Boolean)
    && Object.values(modeChecks).every(Boolean)
    && Object.values(consistency).every(Boolean);

  // countsAsPhase0Pass must equal the independently computed pass (and phase0Passed if present).
  const countsFlag = raw.countsAsPhase0Pass;
  const phase0Flag = raw.phase0Passed;
  const flagConsistency = {
    countsAsPhase0PassEqualsComputed: countsFlag === undefined || countsFlag === computedPass,
    phase0PassedEqualsComputed: phase0Flag === undefined || phase0Flag === computedPass,
    countsEqualsPhase0Passed: countsFlag === undefined || phase0Flag === undefined || countsFlag === phase0Flag,
  };

  // Recompute header countsAsPhase0PassMatchesComputed with flag consistency.
  headerChecks.countsAsPhase0PassMatchesComputed = Object.values(flagConsistency).every(Boolean);

  const checks = {
    ...headerChecks,
    ...modeChecks,
    ...consistency,
    ...flagConsistency,
    memorizationPassed: memorization.passed,
    generalizationPassed: generalization.passed,
    // Explicitly record that unlock does NOT trust report booleans:
    ignoredReportAutonomousUnlockBoolean: true,
  };

  const passed = computedPass && Object.values(flagConsistency).every(Boolean);
  return {
    passed,
    checks,
    reason: passed
      ? "GPU Phase 0 v3 evidence independently satisfies conservative-bound gate"
      : "Phase 0 v3 report present but independent evidence checks failed",
    memorization,
    generalization,
  };
}

/**
 * Autonomous training unlocks only from independently validated GPU v3 evidence.
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
        // Continue — prior versions stay locked; still require a v3 evidence pass.
      }
    } catch {
      // Ignore unreadable supersession marker; fail closed via missing v3 report.
    }
  }

  if (!reportPath || !existsSync(reportPath)) {
    return {
      autonomousTrainingEnabled: false,
      phase0GpuPassRecorded: false,
      phase0ReportPath: reportPath,
      thresholdsVersionRequired: C18D_PHASE0_THRESHOLDS_VERSION,
      reason: "No GPU Phase 0 v3 pass report recorded; autonomous training remains disabled",
    };
  }

  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
    const validated = validatePhase0V3GpuReport(report);
    return {
      autonomousTrainingEnabled: validated.passed,
      phase0GpuPassRecorded: validated.passed,
      phase0ReportPath: reportPath,
      thresholdsVersionRequired: C18D_PHASE0_THRESHOLDS_VERSION,
      reason: validated.reason,
      independentChecks: validated.checks,
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
