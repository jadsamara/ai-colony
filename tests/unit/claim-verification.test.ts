import { describe, expect, it } from "vitest";
import {
  CALC_CONSTANTS,
  STANDARD_GRAVITY_M_S2,
  evaluateCalc,
  tsiolkovskyPropellantMass,
  verifyNumericalClaim,
  withinTolerance,
  type CalcNode,
} from "@ai-colony/core";

describe("C1.7.4 calculation and numerical verification", () => {
  it("evaluates allowlisted arithmetic, powers, and logs without eval", () => {
    const expression: CalcNode = {
      kind: "add",
      left: {
        kind: "mul",
        left: { kind: "literal", value: 2 },
        right: { kind: "pow", base: { kind: "literal", value: 3 }, exponent: { kind: "literal", value: 2 } },
      },
      right: { kind: "ln", arg: { kind: "exp", arg: { kind: "literal", value: 1 } } },
    };
    expect(evaluateCalc(expression)).toBeCloseTo(19, 12);
    expect(evaluateCalc({ kind: "constant", name: "g0" })).toBe(STANDARD_GRAVITY_M_S2);
    expect(CALC_CONSTANTS.g0).toBe(9.80665);
  });

  it("rejects division by zero and invalid log domains", () => {
    expect(() =>
      evaluateCalc({
        kind: "div",
        left: { kind: "literal", value: 1 },
        right: { kind: "literal", value: 0 },
      }),
    ).toThrow(/division by zero/i);
    expect(() => evaluateCalc({ kind: "ln", arg: { kind: "literal", value: 0 } })).toThrow(/positive/i);
  });

  it("computes Tsiolkovsky propellant masses for chemical and ion Isp with g0", () => {
    const chemical = tsiolkovskyPropellantMass({
      dryMassKg: 1000,
      deltaV_m_s: 3000,
      isp_s: 350,
    });
    const ion = tsiolkovskyPropellantMass({
      dryMassKg: 1000,
      deltaV_m_s: 3000,
      isp_s: 3000,
    });
    expect(chemical.g0_m_s2).toBe(STANDARD_GRAVITY_M_S2);
    expect(chemical.equation).toContain("Isp * g0");
    expect(chemical.propellantMassKg).toBeGreaterThan(1300);
    expect(chemical.propellantMassKg).toBeLessThan(1500);
    expect(chemical.propellantMassKg).toBeCloseTo(1396, -1);
    expect(ion.propellantMassKg).toBeGreaterThan(90);
    expect(ion.propellantMassKg).toBeLessThan(120);
    expect(ion.propellantMassKg).toBeCloseTo(107, -1);
    expect(ion.propellantMassKg).toBeLessThan(chemical.propellantMassKg);
  });

  it("verifies approximate chemical and ion propellant claims and refutes ion>chemical", () => {
    const chemicalOk = verifyNumericalClaim({
      kind: "tsiolkovsky_propellant_mass",
      input: { dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 350 },
      claimedPropellantMassKg: 1396,
      tolerance: { relative: 0.03, absolute: 40 },
    });
    expect(chemicalOk.ok).toBe(true);
    expect(chemicalOk.verdict).toBe("verified");

    const ionOk = verifyNumericalClaim({
      kind: "tsiolkovsky_propellant_mass",
      input: { dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 3000 },
      claimedPropellantMassKg: 107,
      tolerance: { relative: 0.05, absolute: 10 },
    });
    expect(ionOk.ok).toBe(true);
    expect(ionOk.verdict).toBe("verified");

    const falseIonMore = verifyNumericalClaim({
      kind: "tsiolkovsky_propellant_comparison",
      left: { label: "ion", dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 3000 },
      right: { label: "chemical", dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 350 },
      claimedRelation: "greater_than",
    });
    expect(falseIonMore.ok).toBe(true);
    expect(falseIonMore.verdict).toBe("refuted");
    expect(falseIonMore.diagnostic).toMatch(/claimed ion greater_than chemical/i);

    const trueIonLess = verifyNumericalClaim({
      kind: "tsiolkovsky_propellant_comparison",
      left: { label: "ion", dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 3000 },
      right: { label: "chemical", dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 350 },
      claimedRelation: "less_than",
    });
    expect(trueIonLess.verdict).toBe("verified");
  });

  it("does not treat an unsupported numerical claim as verified", () => {
    const wrong = verifyNumericalClaim({
      kind: "tsiolkovsky_propellant_mass",
      input: { dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 350 },
      claimedPropellantMassKg: 50,
      tolerance: { relative: 0.01, absolute: 5 },
    });
    expect(wrong.verdict).toBe("refuted");
    expect(withinTolerance(50, 1396, { relative: 0.01 }).ok).toBe(false);
  });
});
