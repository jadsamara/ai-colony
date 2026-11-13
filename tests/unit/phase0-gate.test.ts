import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PHASE0_THRESHOLDS,
  assertAutonomousTrainingAllowed,
  classifyPredictionOutcome,
  evaluationValidity,
  judgeGeneralizationControl,
  judgeMemorizationControl,
  readAutonomousLearningFlags,
} from "@ai-colony/core";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("C1.8D Phase 0 gate (thresholds v2)", () => {
  it("uses predeclared v2 thresholds with two matched eval modes", () => {
    expect(DEFAULT_PHASE0_THRESHOLDS.specVersion).toBe("c18d-phase0-thresholds-v2");
    expect(DEFAULT_PHASE0_THRESHOLDS.declaredBeforeTraining).toBe(true);
    expect(DEFAULT_PHASE0_THRESHOLDS.evaluation.modes).toHaveLength(2);
    expect(DEFAULT_PHASE0_THRESHOLDS.evaluation.maxBaseInvalidRate).toBe(0.05);
    expect(DEFAULT_PHASE0_THRESHOLDS.memorization.minExactMatchPerMode).toBe(0.95);
    expect(DEFAULT_PHASE0_THRESHOLDS.generalization.minHeldoutExactMatchPerMode).toBe(0.9);
    expect(DEFAULT_PHASE0_THRESHOLDS.generalization.minHeldoutItems).toBe(100);
    expect(DEFAULT_PHASE0_THRESHOLDS.generalization.minTrainItems).toBe(200);
    expect(DEFAULT_PHASE0_THRESHOLDS.localSmoke.countsAsPhase0Pass).toBe(false);
  });

  it("separates invalid predictions from wrong answers", () => {
    expect(classifyPredictionOutcome({ exactMatch: false, invalid: true })).toBe("invalid");
    expect(classifyPredictionOutcome({ exactMatch: false, invalid: false })).toBe("wrong");
    expect(classifyPredictionOutcome({ exactMatch: true, invalid: false })).toBe("correct");
  });

  it("marks an evaluation invalid when base invalidRate exceeds 5%", () => {
    expect(evaluationValidity({ invalidRate: 0.2 }).evaluationValid).toBe(false);
    expect(evaluationValidity({ invalidRate: 0.01 }).evaluationValid).toBe(true);
  });

  it("fails memorization when the base evaluation is invalid even if adapter scores high", () => {
    const fail = judgeMemorizationControl({
      exactMatch: 1,
      sampleSize: 8,
      adapterLoaded: true,
      adapterWeightsChanged: true,
      baseInvalidRate: 0.5,
      evaluationValid: false,
    });
    expect(fail.passed).toBe(false);
    expect(fail.checks.evaluationValid).toBe(false);
  });

  it("requires held-out lift over base for generalization under valid eval", () => {
    const pass = judgeGeneralizationControl({
      heldoutExactMatch: 0.95,
      baseExactMatch: 0.1,
      sampleSize: 100,
      adapterLoaded: true,
      adapterWeightsChanged: true,
      baseInvalidRate: 0,
      evaluationValid: true,
    });
    expect(pass.passed).toBe(true);

    const noLift = judgeGeneralizationControl({
      heldoutExactMatch: 0.95,
      baseExactMatch: 0.9,
      sampleSize: 100,
      adapterLoaded: true,
      adapterWeightsChanged: true,
      evaluationValid: true,
    });
    expect(noLift.passed).toBe(false);
    expect(noLift.checks.improvementPass).toBe(false);
  });

  it("keeps autonomous training disabled without a v2 GPU pass report", () => {
    const flags = readAutonomousLearningFlags({ reportPath: join(tmpdir(), "missing-phase0-v2.json") });
    expect(flags.autonomousTrainingEnabled).toBe(false);
    expect(flags.thresholdsVersionRequired).toBe("c18d-phase0-thresholds-v2");
    expect(() => assertAutonomousTrainingAllowed(flags)).toThrow(/disabled/i);
  });

  it("does not unlock from a superseded or v1-style report", () => {
    const dir = mkdtempSync(join(tmpdir(), "c18d-phase0-report-"));
    tempRoots.push(dir);
    const reportPath = join(dir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        mode: "gpu-controls",
        phase0Passed: true,
        countsAsPhase0Pass: true,
        thresholdsVersion: "c18d-phase0-thresholds-v1",
        autonomousTrainingUnlocked: true,
      }),
    );
    const flags = readAutonomousLearningFlags({ reportPath });
    expect(flags.autonomousTrainingEnabled).toBe(false);
  });

  it("unlocks only from an operator gpu-controls-v2 pass report", () => {
    const dir = mkdtempSync(join(tmpdir(), "c18d-phase0-report-"));
    tempRoots.push(dir);
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        mode: "gpu-controls-v2",
        phase0Passed: true,
        countsAsPhase0Pass: true,
        thresholdsVersion: "c18d-phase0-thresholds-v2",
        autonomousTrainingUnlocked: true,
      }),
    );
    const flags = readAutonomousLearningFlags({ reportPath });
    expect(flags.autonomousTrainingEnabled).toBe(true);
    expect(() => assertAutonomousTrainingAllowed(flags)).not.toThrow();
  });
});
