import { describe, expect, it } from "vitest";
import { discordantPairWilsonInterval, newcombePairedDifference } from "@ai-colony/core";

describe("paired accuracy difference interval", () => {
  it("matches Newcombe's published method 10 limits", () => {
    const interval = newcombePairedDifference({ bothCorrect: 20, baselineOnly: 2, candidateOnly: 12, neitherCorrect: 16 });
    expect(interval.low).toBeCloseTo(0.056156424841748265, 12);
    expect(interval.high).toBeCloseTo(0.3292069954001405, 12);
    expect(interval.low).toBeLessThan(0.2);
    expect(interval.high).toBeGreaterThan(0.2);
  });

  it("keeps a concordant sample away from a false point interval", () => {
    const interval = newcombePairedDifference({ bothCorrect: 54, baselineOnly: 0, candidateOnly: 0, neitherCorrect: 0 });
    expect(interval.low).toBeCloseTo(-0.06641358809089626, 12);
    expect(interval.high).toBeCloseTo(0.06641358809089626, 12);
    const mixed = newcombePairedDifference({ bothCorrect: 20, baselineOnly: 0, candidateOnly: 0, neitherCorrect: 10 });
    expect(mixed.low).toBeLessThan(0);
    expect(mixed.high).toBeGreaterThan(0);
    expect(discordantPairWilsonInterval(0, 0, 30)).toEqual({ low: 0, high: 0 });
  });

  it("covers one discordant pair, complete flips, balance, and the parameter bounds", () => {
    const one = newcombePairedDifference({ bothCorrect: 0, baselineOnly: 0, candidateOnly: 1, neitherCorrect: 0 });
    expect(one.low).toBeLessThan(0);
    expect(one.high).toBe(1);
    const improved = newcombePairedDifference({ bothCorrect: 0, baselineOnly: 0, candidateOnly: 30, neitherCorrect: 0 });
    expect(improved.low).toBeCloseTo(0.8394678198623838, 12);
    expect(improved.high).toBe(1);
    expect(improved.low).not.toBeCloseTo(discordantPairWilsonInterval(30, 0, 30).low, 2);
    const regressed = newcombePairedDifference({ bothCorrect: 0, baselineOnly: 30, candidateOnly: 0, neitherCorrect: 0 });
    expect(regressed.low).toBe(-1);
    expect(regressed.high).toBeCloseTo(-0.8394678198623838, 12);
    const balanced = newcombePairedDifference({ bothCorrect: 40, baselineOnly: 30, candidateOnly: 30, neitherCorrect: 40 });
    expect(balanced.low).toBeLessThan(0);
    expect(balanced.high).toBeGreaterThan(0);
    expect(balanced.low).toBeCloseTo(-balanced.high, 12);
    const large = newcombePairedDifference({ bothCorrect: 400, baselineOnly: 20, candidateOnly: 80, neitherCorrect: 500 });
    expect(large.low).toBeGreaterThan(0);
    expect(large.high).toBeLessThan(1);
    expect(large.high - large.low).toBeLessThan(0.2);
    for (const interval of [one, improved, regressed, balanced, large]) {
      expect(interval.low).toBeGreaterThanOrEqual(-1);
      expect(interval.high).toBeLessThanOrEqual(1);
      expect(interval.low).toBeLessThanOrEqual(interval.high);
    }
    expect(newcombePairedDifference({ bothCorrect: 0, baselineOnly: 0, candidateOnly: 0, neitherCorrect: 0 })).toEqual({ low: 0, high: 0 });
    expect(newcombePairedDifference({ bothCorrect: 1.5, baselineOnly: 0, candidateOnly: 0, neitherCorrect: 0 })).toEqual({ low: 0, high: 0 });
  });
});
