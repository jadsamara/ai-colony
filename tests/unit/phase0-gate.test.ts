import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PHASE0_THRESHOLDS,
  assertAutonomousTrainingAllowed,
  classifyPredictionOutcome,
  computeConservativeAccuracyBounds,
  computeConservativeImprovement,
  evaluationValidity,
  judgeGeneralizationControl,
  judgeMemorizationControl,
  readAutonomousLearningFlags,
  validatePhase0V3GpuReport,
} from "@ai-colony/core";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function gatingRow(input: {
  baseCorrect: number;
  baseWrong: number;
  baseInvalid: number;
  adapterCorrect: number;
  adapterWrong: number;
  adapterInvalid: number;
  adapterLoaded?: boolean;
  adapterWeightsChanged?: boolean;
}) {
  const baseTotal = input.baseCorrect + input.baseWrong + input.baseInvalid;
  const adapterTotal = input.adapterCorrect + input.adapterWrong + input.adapterInvalid;
  const baseUpper = (input.baseCorrect + input.baseInvalid) / baseTotal;
  const adapterLower = input.adapterCorrect / adapterTotal;
  return {
    thinkingMode: "thinking_disabled",
    affectsGate: true,
    sampleSize: adapterTotal,
    adapterLoaded: input.adapterLoaded ?? true,
    adapterWeightsChanged: input.adapterWeightsChanged ?? true,
    base: {
      correct: input.baseCorrect,
      wrong: input.baseWrong,
      invalid: input.baseInvalid,
      sampleSize: baseTotal,
      observedAccuracy: input.baseCorrect / baseTotal,
      upperBoundAccuracy: baseUpper,
    },
    adapter: {
      correct: input.adapterCorrect,
      wrong: input.adapterWrong,
      invalid: input.adapterInvalid,
      sampleSize: adapterTotal,
      observedAccuracy: input.adapterCorrect / adapterTotal,
      lowerBoundAccuracy: adapterLower,
    },
    baseUpperBoundAccuracy: baseUpper,
    adapterLowerBoundAccuracy: adapterLower,
    conservativeImprovement: adapterLower - baseUpper,
    observedAdapterAccuracy: input.adapterCorrect / adapterTotal,
    observedBaseAccuracy: input.baseCorrect / baseTotal,
  };
}

function v3Report(overrides: Record<string, unknown> = {}) {
  const mem = gatingRow({
    baseCorrect: 0,
    baseWrong: 0,
    baseInvalid: 8,
    adapterCorrect: 8,
    adapterWrong: 0,
    adapterInvalid: 0,
  });
  const gen = gatingRow({
    baseCorrect: 0,
    baseWrong: 71,
    baseInvalid: 29,
    adapterCorrect: 100,
    adapterWrong: 0,
    adapterInvalid: 0,
  });
  return {
    specVersion: "c18d-phase0-report-v3",
    thresholdsVersion: "c18d-phase0-thresholds-v3",
    mode: "gpu-controls-v3",
    status: "pass",
    gatingMode: "thinking_disabled",
    thinkingEnabledSkipped: true,
    memorization: { passedInGatingMode: true, gatingMode: mem },
    generalization: { passedInGatingMode: true, gatingMode: gen },
    phase0Passed: true,
    countsAsPhase0Pass: true,
    autonomousTrainingUnlocked: true,
    ...overrides,
  };
}

describe("C1.8D Phase 0 gate (thresholds v3)", () => {
  it("uses v3 thresholds with conservative bounds and 256-token gating mode", () => {
    expect(DEFAULT_PHASE0_THRESHOLDS.specVersion).toBe("c18d-phase0-thresholds-v3");
    expect(DEFAULT_PHASE0_THRESHOLDS.declaredBeforeTraining).toBe(false);
    expect(DEFAULT_PHASE0_THRESHOLDS.evaluation.gatingMode).toBe("thinking_disabled");
    expect(DEFAULT_PHASE0_THRESHOLDS.evaluation.comparisonMethod).toBe("conservative_worst_case_bounds");
    expect(DEFAULT_PHASE0_THRESHOLDS.evaluation.hardBaseInvalidRateCutoff).toBe(false);
    expect(DEFAULT_PHASE0_THRESHOLDS.evaluation.modes[0]).toMatchObject({
      id: "thinking_disabled",
      role: "gating",
      maxNewTokens: 256,
    });
    expect(DEFAULT_PHASE0_THRESHOLDS.gpuGate.requiredReportMode).toBe("gpu-controls-v3");
    expect(DEFAULT_PHASE0_THRESHOLDS.memorization.requireImprovementOverBase).toBe(false);
  });

  it("computes conservative upper/lower accuracy bounds", () => {
    // Mirrors the v2.1 generalization observation shape: 0 correct, 71 wrong, 29 invalid.
    const base = computeConservativeAccuracyBounds({ correct: 0, wrong: 71, invalid: 29 });
    expect(base.upperBoundAccuracy).toBeCloseTo(0.29);
    expect(base.lowerBoundAccuracy).toBe(0);
    const adapter = computeConservativeAccuracyBounds({ correct: 100, wrong: 0, invalid: 0 });
    expect(adapter.lowerBoundAccuracy).toBe(1);
    const improvement = computeConservativeImprovement({
      base: { correct: 0, wrong: 71, invalid: 29 },
      adapter: { correct: 100, wrong: 0, invalid: 0 },
    });
    expect(improvement.conservativeImprovement).toBeCloseTo(0.71);
  });

  it("separates invalid predictions from wrong answers", () => {
    expect(classifyPredictionOutcome({ exactMatch: false, invalid: true })).toBe("invalid");
    expect(classifyPredictionOutcome({ exactMatch: false, invalid: false })).toBe("wrong");
    expect(classifyPredictionOutcome({ exactMatch: true, invalid: false })).toBe("correct");
  });

  it("keeps legacy evaluationValidity helper but does not use it for v3 gating", () => {
    expect(evaluationValidity({ invalidRate: 0.2 }).evaluationValid).toBe(false);
  });

  it("passes memorization on absolute adapter lower-bound without base-invalid cutoff", () => {
    const pass = judgeMemorizationControl({
      sampleSize: 8,
      adapterLoaded: true,
      adapterWeightsChanged: true,
      adapterCorrect: 8,
      adapterWrong: 0,
      adapterInvalid: 0,
      baseCorrect: 0,
      baseWrong: 0,
      baseInvalid: 8,
    });
    expect(pass.passed).toBe(true);
    expect(pass.checks.adapterLowerBoundPass).toBe(true);
  });

  it("passes generalization when conservative improvement clears the floor", () => {
    const pass = judgeGeneralizationControl({
      sampleSize: 100,
      adapterLoaded: true,
      adapterWeightsChanged: true,
      baseCorrect: 0,
      baseWrong: 71,
      baseInvalid: 29,
      adapterCorrect: 100,
      adapterWrong: 0,
      adapterInvalid: 0,
    });
    expect(pass.passed).toBe(true);
    expect(pass.improvement).toBeGreaterThanOrEqual(0.5);

    const noLift = judgeGeneralizationControl({
      sampleSize: 100,
      adapterLoaded: true,
      adapterWeightsChanged: true,
      baseCorrect: 50,
      baseWrong: 0,
      baseInvalid: 50,
      adapterCorrect: 90,
      adapterWrong: 10,
      adapterInvalid: 0,
    });
    // adapter lower 0.9 - base upper 1.0 = -0.1
    expect(noLift.passed).toBe(false);
    expect(noLift.checks.conservativeImprovementPass).toBe(false);
  });

  it("does not unlock from report booleans alone", () => {
    const forged = validatePhase0V3GpuReport({
      mode: "gpu-controls-v3",
      thresholdsVersion: "c18d-phase0-thresholds-v3",
      gatingMode: "thinking_disabled",
      phase0Passed: true,
      countsAsPhase0Pass: true,
      autonomousTrainingUnlocked: true,
    });
    expect(forged.passed).toBe(false);
  });

  it("unlocks only when independent v3 evidence checks pass", () => {
    const validated = validatePhase0V3GpuReport(v3Report());
    expect(validated.passed).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "c18d-phase0-v3-"));
    tempRoots.push(dir);
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify(v3Report()));
    const flags = readAutonomousLearningFlags({ reportPath });
    expect(flags.autonomousTrainingEnabled).toBe(true);
    expect(() => assertAutonomousTrainingAllowed(flags)).not.toThrow();
  });

  it("rejects v2.1-style unlock reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "c18d-phase0-v21-"));
    tempRoots.push(dir);
    const reportPath = join(dir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        mode: "gpu-controls-v2",
        phase0Passed: true,
        countsAsPhase0Pass: true,
        thresholdsVersion: "c18d-phase0-thresholds-v2.1",
        autonomousTrainingUnlocked: true,
      }),
    );
    const flags = readAutonomousLearningFlags({ reportPath });
    expect(flags.autonomousTrainingEnabled).toBe(false);
    expect(flags.thresholdsVersionRequired).toBe("c18d-phase0-thresholds-v3");
  });

  it("rejects inconsistent countsAsPhase0Pass vs computed evidence", () => {
    const validated = validatePhase0V3GpuReport(
      v3Report({ phase0Passed: true, countsAsPhase0Pass: false }),
    );
    expect(validated.passed).toBe(false);
    expect(validated.checks.countsEqualsPhase0Passed).toBe(false);
  });

  it("keeps autonomous training disabled without a v3 report", () => {
    const flags = readAutonomousLearningFlags({ reportPath: join(tmpdir(), "missing-phase0-v3.json") });
    expect(flags.autonomousTrainingEnabled).toBe(false);
    expect(() => assertAutonomousTrainingAllowed(flags)).toThrow(/disabled/i);
  });
});
