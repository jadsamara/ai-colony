import { gradeArithmetic } from "@ai-colony/core";
import { claimSignificance, mcnemarExact, pairedCounts, wilsonInterval } from "@ai-colony/core";
import { decideGate, GATE_POLICY } from "@ai-colony/core";
import { describe, expect, it } from "vitest";

const historical = [
  { expected: "1", baseline: "0 + 1 = 1", candidate: "11" },
  { expected: "10", baseline: "0 + 10 = 1", candidate: "10" },
  { expected: "7", baseline: "0 + 7 = 7", candidate: "11" },
  { expected: "13", baseline: "1 + 12 = 1", candidate: "15" },
  { expected: "9", baseline: "2 + 7 = 9", candidate: "19" },
];

describe("evaluation scoring and gates", () => {
  it("gives equation answers task credit and withholds it from a wrong integer", () => {
    const equation = gradeArithmetic("9", "2 + 7 = 9");
    const wrongInteger = gradeArithmetic("9", "19");
    const buried = gradeArithmetic("9", "I think 9 is plausible");
    expect(equation.taskCorrect).toBe(true);
    expect(equation.strictIntegerMatch).toBe(false);
    expect(equation.formatValid).toBe(true);
    expect(wrongInteger.taskCorrect).toBe(false);
    expect(wrongInteger.formatValid).toBe(true);
    expect(wrongInteger.strictIntegerMatch).toBe(false);
    expect(buried.taskCorrect).toBe(false);
    expect(buried.ambiguous).toBe(false);
    expect(buried.formatValid).toBe(false);
  });

  it("scores the recorded M5 outputs without treating five items as significant", () => {
    const grades = historical.map((row) => ({
      baseline: gradeArithmetic(row.expected, row.baseline).taskCorrect,
      candidate: gradeArithmetic(row.expected, row.candidate).taskCorrect,
    }));
    const paired = pairedCounts(
      grades.map((row) => row.baseline),
      grades.map((row) => row.candidate),
    );
    expect(paired.baselineAccuracy).toBeCloseTo(0.6);
    expect(paired.candidateAccuracy).toBeCloseTo(0.2);
    expect(paired.baselineOnly).toBe(3);
    expect(paired.candidateOnly).toBe(1);
    const interval = wilsonInterval(1, 5);
    expect(interval.low).toBeLessThan(0.2);
    expect(interval.high).toBeGreaterThan(0.2);
    expect(claimSignificance(5, GATE_POLICY.minSampleForPass, mcnemarExact(paired.baselineOnly, paired.candidateOnly))).toBe(false);
    const gate = decideGate({
      domain: "arithmetic",
      paired,
      baselineFormat: 1,
      candidateFormat: 1,
      checksumsMatch: true,
      contaminated: false,
    });
    expect(gate.decision).toBe("FAIL");
  });

  it("keeps a small improvement inconclusive and a large clean comparison eligible", () => {
    const small = pairedCounts([false, false, false, false, false], [true, true, true, true, true]);
    expect(decideGate({ domain: "arithmetic", paired: small, baselineFormat: 1, candidateFormat: 1, checksumsMatch: true, contaminated: false }).decision).toBe("INCONCLUSIVE");
    const largeBaseline = Array.from({ length: 30 }, () => true);
    const large = pairedCounts(largeBaseline, largeBaseline);
    expect(decideGate({ domain: "arithmetic", paired: large, baselineFormat: 1, candidateFormat: 1, checksumsMatch: true, contaminated: false }).decision).toBe("PASS");
    expect(decideGate({ domain: "arithmetic", paired: large, baselineFormat: 1, candidateFormat: 1, checksumsMatch: false, contaminated: false }).decision).toBe("QUARANTINED");
  });
});
