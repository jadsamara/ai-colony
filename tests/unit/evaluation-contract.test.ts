import { describe, expect, it } from "vitest";
import {
  analyzePairedRuns,
  applyGateIfComparable,
  classifyItem,
  colonyRunContract,
  compareManifests,
  configurationFingerprint,
  contentDigest,
  itemSetFingerprint,
  legacyManifest,
  mcnemarExact,
  parseEvaluationManifest,
  summarizeItems,
  verifyImprovement,
  type EvaluationManifest,
} from "@ai-colony/core";
import { pairedCounts } from "@ai-colony/core";

const recordedAt = "2026-11-02T00:00:00.000Z";

describe("evaluation contract", () => {
  it("validates a manifest and keeps fingerprints stable across run identity", () => {
    const first = run({ runId: "run-a" });
    const second = run({ runId: "run-b", recordedAt: "2026-11-03T00:00:00.000Z" });
    expect(configurationFingerprint(first.candidate)).toBe(configurationFingerprint(second.candidate));
    expect(configurationFingerprint(run({ maxOutputTokens: 32 }).candidate)).not.toBe(configurationFingerprint(first.candidate));
    const items = [
      { id: "b", contentDigest: contentDigest("b") },
      { id: "a", contentDigest: contentDigest("a") },
    ];
    expect(itemSetFingerprint(items)).toBe(itemSetFingerprint([...items].reverse()));
    expect(() => parseEvaluationManifest({ contractVersion: "other" })).toThrow();
  });

  it("allows model and adapter identity to differ and rejects execution confounders", () => {
    const base = run();
    const otherAdapter = run({ adapterId: "adapter-2", adapterDigest: contentDigest("adapter-b") });
    const matched = compareManifests(base.candidate, otherAdapter.candidate);
    expect(matched.comparable).toBe(true);
    expect(matched.allowedDifferences).toContain("model.adapterDigest");
    const quantized = run({ quantization: "8bit" });
    const confounder = compareManifests(base.candidate, quantized.candidate);
    expect(confounder.comparable).toBe(false);
    expect(confounder.confounders).toContain("model.quantization");
    const qualified = compareManifests(base.candidate, quantized.candidate, {
      kind: "qualified",
      acceptedConfounders: ["model.quantization"],
    });
    expect(qualified.comparable).toBe(true);
    expect(qualified.design).toBe("qualified");
  });

  it("rejects historical Gemma and Qwen budgets, prompt changes, and invented metadata", () => {
    const gemma8 = run({
      maxOutputTokens: 8,
      family: "gemma-3",
      identifier: "gemma-3-270m",
      checkpointDigest: contentDigest("gemma-checkpoint"),
    });
    const qwen32 = run({
      maxOutputTokens: 32,
      family: "qwen3",
      identifier: "Qwen3-1.7B",
      checkpointDigest: contentDigest("qwen-checkpoint"),
      promptTemplateDigest: contentDigest("m75-prompt-a"),
    });
    const qwen128 = run({
      maxOutputTokens: 128,
      family: "qwen3",
      identifier: "Qwen3-1.7B",
      checkpointDigest: contentDigest("qwen-checkpoint"),
      promptTemplateDigest: contentDigest("m75-prompt-a"),
    });
    const promptB = run({
      maxOutputTokens: 128,
      family: "qwen3",
      identifier: "Qwen3-1.7B",
      checkpointDigest: contentDigest("qwen-checkpoint"),
      promptTemplateDigest: contentDigest("m75-prompt-b"),
    });
    expect(compareManifests(gemma8.candidate, qwen32.candidate).comparable).toBe(false);
    expect(compareManifests(gemma8.candidate, qwen128.candidate).comparable).toBe(false);
    const budget = compareManifests(qwen32.candidate, qwen128.candidate);
    expect(budget.comparable).toBe(false);
    expect(budget.differed).toContain("generation.maxOutputTokens");
    expect(budget.pairedComparisonPossible).toBe(false);
    const prompts = compareManifests(qwen128.candidate, promptB.candidate);
    expect(prompts.comparable).toBe(false);
    expect(prompts.differed).toContain("evaluation.promptTemplateDigest");
    const retrieval = withRetrieval(qwen128.candidate, "retrieval_assisted");
    expect(compareManifests(qwen128.candidate, retrieval).differed).toContain("generation.retrieval");
    const otherScorer = parseEvaluationManifest({
      ...qwen128.candidate,
      evaluation: { ...qwen128.candidate.evaluation, scorerVersion: { state: "set", value: "last-integer-v1" } },
    });
    expect(compareManifests(qwen128.candidate, otherScorer).differed).toContain("evaluation.scorerVersion");
    const otherItems = run({
      maxOutputTokens: 128,
      family: "qwen3",
      identifier: "Qwen3-1.7B",
      checkpointDigest: contentDigest("qwen-checkpoint"),
      promptTemplateDigest: contentDigest("m75-prompt-a"),
      itemSetFingerprint: itemSetFingerprint([{ id: "other", contentDigest: contentDigest("other") }]),
    });
    expect(compareManifests(qwen128.candidate, otherItems.candidate).differed).toContain("evaluation.itemSetFingerprint");
    const legacy = legacyManifest({
      decoding: { strategy: "greedy", maxTokens: 8, temperature: 0 },
      benchmarkId: null,
      benchmarkVersion: null,
      itemSetFingerprint: null,
      promptTemplateDigest: null,
      scorerId: null,
      scorerVersion: null,
      checkpointDigest: null,
      adapterDigest: null,
    });
    expect(legacy.model.checkpointDigest.state).toBe("unknown");
    expect(legacy.generation.thinking.state).toBe("unknown");
    expect(compareManifests(legacy, legacy).design).toBe("indeterminate");
  });

  it("classifies truncation only from termination evidence and keeps denominators explicit", () => {
    const correct = classifyItem(evidence({ taskCorrect: true, formatValid: true, extractionOk: true, termination: "stop", truncationEvidence: "none" }));
    const wrong = classifyItem(evidence({ taskCorrect: false, formatValid: true, extractionOk: true, termination: "stop", truncationEvidence: "none" }));
    const format = classifyItem(evidence({ taskCorrect: false, formatValid: false, extractionOk: true, termination: "stop", truncationEvidence: "none" }));
    const confirmed = classifyItem(evidence({ termination: "length", truncationEvidence: "confirmed" }));
    const suspected = classifyItem(evidence({ termination: "unknown", truncationEvidence: "suspected" }));
    const unknownStop = classifyItem(evidence({ termination: "unknown", truncationEvidence: "absent" }));
    expect(correct.taskCorrectness).toBe("correct");
    expect(wrong.taskCorrectness).toBe("incorrect");
    expect(format.outputValidity).toBe("invalid_format");
    expect(format.taskCorrectness).toBe("unknown");
    expect(confirmed.truncation).toBe("confirmed");
    expect(suspected.truncation).toBe("suspected");
    expect(unknownStop.truncation).toBe("indeterminate");
    const metrics = summarizeItems([correct, wrong, format, confirmed]);
    expect(metrics.endToEndDenominator).toBe(4);
    expect(metrics.endToEndSuccessRate).toBe(0.25);
    expect(metrics.conditionalDenominator).toBe(2);
    expect(metrics.conditionalAccuracy).toBe(0.5);
    expect(metrics.formatFailures).toBe(1);
    expect(metrics.confirmedTruncations).toBe(1);
  });

  it("computes paired improvement, regression, and null results without authorizing deployment", () => {
    const baseline = run({ maxOutputTokens: 128, family: "qwen3", checkpointDigest: contentDigest("qwen-checkpoint") });
    const candidate = run({
      maxOutputTokens: 128,
      family: "qwen3",
      checkpointDigest: contentDigest("qwen-checkpoint"),
      adapterDigest: contentDigest("adapter-b"),
    });
    const items = Array.from({ length: 30 }, (_, index) => ({
      itemId: `item-${index}`,
      contentDigest: contentDigest(`item-${index}`),
      baselineCorrect: false,
      candidateCorrect: true,
      baselineValid: true,
      candidateValid: true,
    }));
    const improved = analyzePairedRuns({ baseline: baseline.candidate, candidate: candidate.candidate, items });
    expect(improved.verdict).toBe("improvement");
    expect(improved.pValue).toBe(2 / 2 ** 30);
    expect(improved.pairedInterval).toEqual({ low: 1, high: 1 });
    expect(improved.deploymentAuthorization).toBe("separate_decision_required");
    const regressed = analyzePairedRuns({
      baseline: baseline.candidate,
      candidate: candidate.candidate,
      items: items.map((item) => ({ ...item, baselineCorrect: true, candidateCorrect: false })),
    });
    expect(regressed.verdict).toBe("regression");
    expect(regressed.pValue).toBe(2 / 2 ** 30);
    const nullCase = analyzePairedRuns({
      baseline: baseline.candidate,
      candidate: candidate.candidate,
      items: items.map((item, index) => ({ ...item, baselineCorrect: index < 15, candidateCorrect: index >= 15 })),
    });
    expect(nullCase.verdict).toBe("inconclusive");
    expect(nullCase.pValue).toBe(1);
    expect(mcnemarExact(15, 15)).toBe(1);
    const blocked = analyzePairedRuns({
      baseline: baseline.candidate,
      candidate: run({ maxOutputTokens: 32 }).candidate,
      items,
    });
    expect(blocked.verdict).toBe("noncomparable");
    expect(blocked.pValue).toBeNull();
    expect(blocked.absoluteDifference).toBeNull();
  });

  it("fails closed when a gate or improvement caller lacks a comparable contract", () => {
    const dropped = pairedCounts(Array.from({ length: 30 }, () => true), Array.from({ length: 30 }, () => false));
    const comparison = compareManifests(run({ maxOutputTokens: 8 }).candidate, run({ maxOutputTokens: 32 }).candidate);
    const gate = applyGateIfComparable(comparison, {
      domain: "arithmetic",
      paired: dropped,
      baselineFormat: 1,
      candidateFormat: 1,
      checksumsMatch: true,
      contaminated: false,
    });
    expect(gate.decision).toBe("INCONCLUSIVE");
    expect(gate.rationale).not.toMatch(/fell/);
    const invalid = verifyImprovement({
      sampleSize: 30,
      taskBaseline: 1,
      taskCandidate: 0,
      formatBaseline: 1,
      formatCandidate: 1,
      baselineOnly: 30,
      candidateOnly: 0,
      taskBaselineCorrect: 30,
      taskCandidateCorrect: 0,
      checksumsMatch: true,
      contaminated: false,
      familyCompatible: true,
      evaluationPresent: true,
      benchmarkValid: true,
      retentionPresent: true,
      retentionPassed: true,
      comparisonEligible: false,
    });
    expect(invalid.classification).toBe("EVALUATION_INVALID");
  });
});

function run(overrides: Partial<Parameters<typeof colonyRunContract>[0]> = {}) {
  const items = [{ id: "item-1", contentDigest: contentDigest("1+1") }];
  return colonyRunContract({
    runId: "run-1",
    recordedAt,
    family: "gemma-3",
    identifier: "gemma-3-270m",
    alias: "Gemma 3 270M",
    checkpointId: "checkpoint-1",
    checkpointDigest: contentDigest("gemma-checkpoint"),
    adapterId: "adapter-1",
    adapterVersion: "rank-8",
    adapterDigest: contentDigest("adapter-a"),
    quantization: "4bit",
    backendId: "mlx",
    backendVersion: "0.32.2",
    benchmarkId: "arithmetic-suite",
    benchmarkVersion: "1",
    itemSetFingerprint: itemSetFingerprint(items),
    itemCount: items.length,
    promptTemplateDigest: contentDigest("prompt-a"),
    scorerId: "arithmetic",
    scorerVersion: "m6-equation-v1",
    maxOutputTokens: 8,
    temperature: 0,
    contextWindow: 2048,
    ...overrides,
  });
}

function withRetrieval(manifest: EvaluationManifest, value: "closed_book" | "retrieval_assisted"): EvaluationManifest {
  return parseEvaluationManifest({
    ...manifest,
    generation: { ...manifest.generation, retrieval: { state: "set", value } },
  });
}

function evidence(overrides: Partial<Parameters<typeof classifyItem>[0]>): Parameters<typeof classifyItem>[0] {
  return {
    taskCorrect: null,
    formatValid: null,
    extractionOk: null,
    termination: "omitted",
    generationError: false,
    toolOrRetrievalFailure: false,
    scorerFailure: false,
    evidenceComplete: true,
    truncationEvidence: "absent",
    ...overrides,
  };
}
