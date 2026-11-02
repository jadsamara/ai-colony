import { describe, expect, it } from "vitest";
import { lossMasks, paddedWidth } from "../../research/m75c/mask.js";
import { selectIds } from "../../research/m75c/sample.js";
import { classifyResponse, extractDiagnostic, formatCompliant, pairFlips, recovery } from "../../research/m75c/score.js";
import { assessWorking } from "../../research/m75c/working.js";

describe("M7.5C loss-mask audit", () => {
  it("includes one padding target in the installed mask for the historical example width", () => {
    const width = paddedWidth(42, 192);
    expect(width).toBeGreaterThan(42);
    const mask = lossMasks(38, 42, width - 1);
    expect(mask.correctedCount).toBe(4);
    expect(mask.installedCount).toBe(5);
    expect(mask.extraInstalledSteps).toEqual([42]);
  });

  it("does not invent an extra target when the sequence fills the padded buffer", () => {
    const mask = lossMasks(190, 192, 191);
    expect(mask.installedCount).toBe(mask.correctedCount);
    expect(mask.extraInstalledSteps).toEqual([]);
  });

  it("keeps prompt tokens out of both masks and handles a mixed-length row", () => {
    const short = lossMasks(4, 6, 32);
    const long = lossMasks(10, 20, 32);
    expect(short.installed.slice(0, 3).every((bit) => bit === false)).toBe(true);
    expect(short.correctedCount).toBe(2);
    expect(long.correctedCount).toBe(10);
    expect(short.extraInstalledSteps).toEqual([6]);
    expect(long.extraInstalledSteps).toEqual([20]);
  });
});

describe("M7.5C diagnostic scoring", () => {
  it("prefers a labeled final answer and otherwise uses the last integer", () => {
    expect(extractDiagnostic("6 * 8 + 15 = 48 + 15 = 63\nFinal answer: 63")).toEqual({ value: 63, method: "final-answer" });
    expect(extractDiagnostic("6 * 8 + 15 = 48 + 15 = 63\n\nInteger result: 63")).toEqual({ value: 63, method: "last-integer" });
    expect(extractDiagnostic("working 12 then Final answer: 9")).toEqual({ value: 9, method: "final-answer" });
    expect(extractDiagnostic("no digits")).toEqual({ value: null, method: "none" });
  });

  it("classifies bare, worked, unparseable, and other responses", () => {
    expect(classifyResponse("23")).toBe("bare");
    expect(classifyResponse("-4")).toBe("bare");
    expect(classifyResponse("6 * 8 + 15 = 48 + 15 = 63")).toBe("worked");
    expect(classifyResponse("15 - 2 = 13")).toBe("worked");
    expect(classifyResponse("I cannot tell")).toBe("unparseable");
    expect(classifyResponse("The answer is 63")).toBe("other");
    expect(classifyResponse("Let's compute the expression step by step:\n\n$ 20 - 28 $")).toBe("worked");
  });

  it("applies one format rule per prompt", () => {
    expect(formatCompliant("63", "a")).toBe(true);
    expect(formatCompliant("6 * 8 = 48", "a")).toBe(false);
    expect(formatCompliant("6 * 8 = 48\nFinal answer: 48", "b")).toBe(true);
    expect(formatCompliant("48", "b")).toBe(false);
  });

  it("counts correctness flips and exact response changes", () => {
    const flips = pairFlips([true, true, false, false], [true, false, true, false], ["a", "b", "c", "d"], ["a", "B", "c", "d"]);
    expect(flips).toMatchObject({ bothCorrect: 1, firstOnly: 1, secondOnly: 1, neither: 1, changedResponses: 1 });
  });

  it("measures recovery without treating a longer answer as success by itself", () => {
    const result = recovery({ base: 134, candidate: 80, candidateReference: 27, sampleSize: 300 });
    expect(result.points).toBeCloseTo((80 - 27) / 300);
    expect(result.fractionOfLossRecovered).toBeCloseTo((80 - 27) / (134 - 27));
    expect(result.remainsBelowBase).toBe(true);
    expect(recovery({ base: 10, candidate: 10, candidateReference: 10, sampleSize: 10 }).fractionOfLossRecovered).toBeNull();
  });
});

describe("M7.5C working validator", () => {
  it("accepts a chained equality and rejects a broken step", () => {
    expect(assessWorking("6 * 8 + 15 = 48 + 15 = 63\n\nInteger result: 63", 63).verdict).toBe("correct-parseable");
    expect(assessWorking("9 - 24 = -15\n-15 - 10 = -25", -25).verdict).toBe("correct-parseable");
    expect(assessWorking("$ 11 \\times 12 = 132 $\n$ 132 - 26 = 106 $", 106).verdict).toBe("correct-parseable");
    expect(assessWorking("26 * 2 = 52\n52 * 18 = (50 * 18) + (2 * 18)", 936).verdict).toBe("ambiguous");
    expect(assessWorking("6 * 8 + 15 = 40 + 15 = 55", 63).verdict).toBe("incorrect-arithmetic");
    expect(assessWorking("63", 63).verdict).toBe("missing-working");
    expect(assessWorking("6 * 8 + 15 = about sixty", 63).verdict).toBe("unparseable-working");
  });
});

describe("M7.5C qualitative sample", () => {
  it("is deterministic and does not depend on input order", () => {
    const first = selectIds(["b", "a", "c", "d"], 7501, 2);
    const second = selectIds(["d", "c", "b", "a"], 7501, 2);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
  });
});
