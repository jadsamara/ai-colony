import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PHASE0_THRESHOLDS,
  assertAutonomousTrainingAllowed,
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

describe("C1.8D Phase 0 gate", () => {
  it("uses predeclared thresholds that require near-perfect memorization", () => {
    expect(DEFAULT_PHASE0_THRESHOLDS.declaredBeforeTraining).toBe(true);
    expect(DEFAULT_PHASE0_THRESHOLDS.memorization.minExactMatch).toBe(0.95);
    expect(DEFAULT_PHASE0_THRESHOLDS.generalization.minHeldoutExactMatch).toBe(0.9);
    expect(DEFAULT_PHASE0_THRESHOLDS.generalization.minImprovementOverBase).toBe(0.5);
    expect(DEFAULT_PHASE0_THRESHOLDS.localSmoke.countsAsPhase0Pass).toBe(false);
  });

  it("passes memorization only when adapter-loaded recall clears the bar", () => {
    const pass = judgeMemorizationControl({
      exactMatch: 1,
      sampleSize: 8,
      adapterLoaded: true,
      adapterWeightsChanged: true,
    });
    expect(pass.passed).toBe(true);

    const fail = judgeMemorizationControl({
      exactMatch: 0.5,
      sampleSize: 8,
      adapterLoaded: true,
      adapterWeightsChanged: true,
    });
    expect(fail.passed).toBe(false);
    expect(fail.checks.exactMatchPass).toBe(false);
  });

  it("requires held-out lift over base for generalization", () => {
    const pass = judgeGeneralizationControl({
      heldoutExactMatch: 0.95,
      baseExactMatch: 0.1,
      sampleSize: 24,
      adapterLoaded: true,
      adapterWeightsChanged: true,
    });
    expect(pass.passed).toBe(true);
    expect(pass.improvement).toBeCloseTo(0.85);

    const noLift = judgeGeneralizationControl({
      heldoutExactMatch: 0.95,
      baseExactMatch: 0.9,
      sampleSize: 24,
      adapterLoaded: true,
      adapterWeightsChanged: true,
    });
    expect(noLift.passed).toBe(false);
    expect(noLift.checks.improvementPass).toBe(false);
  });

  it("keeps autonomous training disabled without a GPU pass report", () => {
    const flags = readAutonomousLearningFlags({ reportPath: join(tmpdir(), "missing-phase0.json") });
    expect(flags.autonomousTrainingEnabled).toBe(false);
    expect(() => assertAutonomousTrainingAllowed(flags)).toThrow(/disabled/i);
  });

  it("does not unlock from a local-smoke style report", () => {
    const dir = mkdtempSync(join(tmpdir(), "c18d-phase0-report-"));
    tempRoots.push(dir);
    const reportPath = join(dir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        mode: "local-smoke",
        phase0Passed: false,
        countsAsPhase0Pass: false,
        bothControlsPassed: true,
      }),
    );
    const flags = readAutonomousLearningFlags({ reportPath });
    expect(flags.autonomousTrainingEnabled).toBe(false);
  });

  it("unlocks only from an operator gpu-controls pass report", () => {
    const dir = mkdtempSync(join(tmpdir(), "c18d-phase0-report-"));
    tempRoots.push(dir);
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        mode: "gpu-controls",
        phase0Passed: true,
        countsAsPhase0Pass: true,
        bothControlsPassed: true,
      }),
    );
    const flags = readAutonomousLearningFlags({ reportPath });
    expect(flags.autonomousTrainingEnabled).toBe(true);
    expect(() => assertAutonomousTrainingAllowed(flags)).not.toThrow();
  });
});
