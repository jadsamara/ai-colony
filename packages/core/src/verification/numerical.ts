import {
  CalculationError,
  evaluateCalc,
  tsiolkovskyPropellantMass,
  type CalcNode,
  type TsiolkovskyPropellantInput,
  type TsiolkovskyPropellantResult,
} from "./calculation.js";
import { withinTolerance, type ToleranceSpec } from "./tolerance.js";

export type NumericalVerdict = "verified" | "refuted" | "inconclusive";

export type ClaimRelation = "equals" | "greater_than" | "less_than";

export interface NumericalVerificationSuccess {
  ok: true;
  verdict: NumericalVerdict;
  method: "deterministic_calculation";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  diagnostic: string | null;
  computedValue: number | null;
  claimedValue: number | null;
  units: Record<string, string>;
  tolerance: ToleranceSpec | null;
}

export interface NumericalVerificationFailure {
  ok: false;
  verdict: "inconclusive";
  method: "deterministic_calculation";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  diagnostic: string;
  computedValue: number | null;
  claimedValue: number | null;
  units: Record<string, string>;
  tolerance: ToleranceSpec | null;
}

export type NumericalVerificationResult = NumericalVerificationSuccess | NumericalVerificationFailure;

export type NumericalVerificationRequest =
  | {
      kind: "expression";
      expression: CalcNode;
      claimedValue: number;
      units: { value: string };
      tolerance: ToleranceSpec;
    }
  | {
      kind: "tsiolkovsky_propellant_mass";
      input: TsiolkovskyPropellantInput;
      claimedPropellantMassKg: number;
      tolerance: ToleranceSpec;
    }
  | {
      kind: "tsiolkovsky_propellant_comparison";
      left: TsiolkovskyPropellantInput & { label: string };
      right: TsiolkovskyPropellantInput & { label: string };
      claimedRelation: ClaimRelation;
    };

function fail(
  inputs: Record<string, unknown>,
  diagnostic: string,
  extras?: Partial<NumericalVerificationFailure>,
): NumericalVerificationFailure {
  return {
    ok: false,
    verdict: "inconclusive",
    method: "deterministic_calculation",
    inputs,
    outputs: extras?.outputs ?? {},
    diagnostic,
    computedValue: extras?.computedValue ?? null,
    claimedValue: extras?.claimedValue ?? null,
    units: extras?.units ?? {},
    tolerance: extras?.tolerance ?? null,
  };
}

function relationHolds(left: number, right: number, relation: ClaimRelation, tolerance?: ToleranceSpec): boolean {
  if (relation === "equals") {
    return withinTolerance(left, right, tolerance ?? { relative: 1e-9, absolute: 1e-9 }).ok;
  }
  if (relation === "greater_than") {
    return left > right;
  }
  return left < right;
}

export function verifyNumericalClaim(request: NumericalVerificationRequest): NumericalVerificationResult {
  try {
    if (request.kind === "expression") {
      const computed = evaluateCalc(request.expression);
      const check = withinTolerance(request.claimedValue, computed, request.tolerance);
      const verdict: NumericalVerdict = check.ok ? "verified" : "refuted";
      return {
        ok: true,
        verdict,
        method: "deterministic_calculation",
        inputs: { expression: request.expression, claimedValue: request.claimedValue },
        outputs: { computedValue: computed, toleranceCheck: check },
        diagnostic: check.ok ? null : check.reason,
        computedValue: computed,
        claimedValue: request.claimedValue,
        units: { value: request.units.value },
        tolerance: request.tolerance,
      };
    }

    if (request.kind === "tsiolkovsky_propellant_mass") {
      const result = tsiolkovskyPropellantMass(request.input);
      const check = withinTolerance(request.claimedPropellantMassKg, result.propellantMassKg, request.tolerance);
      const verdict: NumericalVerdict = check.ok ? "verified" : "refuted";
      return {
        ok: true,
        verdict,
        method: "deterministic_calculation",
        inputs: { ...request.input, claimedPropellantMassKg: request.claimedPropellantMassKg },
        outputs: { ...result, toleranceCheck: check },
        diagnostic: check.ok ? null : check.reason,
        computedValue: result.propellantMassKg,
        claimedValue: request.claimedPropellantMassKg,
        units: { mass: "kg", velocity: "m/s", isp: "s", g0: "m/s^2" },
        tolerance: request.tolerance,
      };
    }

    const left = tsiolkovskyPropellantMass(request.left);
    const right = tsiolkovskyPropellantMass(request.right);
    const holds = relationHolds(left.propellantMassKg, right.propellantMassKg, request.claimedRelation);
    const verdict: NumericalVerdict = holds ? "verified" : "refuted";
    const diagnostic = holds
      ? null
      : `claimed ${request.left.label} ${request.claimedRelation} ${request.right.label}, but computed ${left.propellantMassKg} vs ${right.propellantMassKg}`;
    return {
      ok: true,
      verdict,
      method: "deterministic_calculation",
      inputs: {
        left: request.left,
        right: request.right,
        claimedRelation: request.claimedRelation,
      },
      outputs: {
        left,
        right,
        actualRelation:
          left.propellantMassKg > right.propellantMassKg
            ? "greater_than"
            : left.propellantMassKg < right.propellantMassKg
              ? "less_than"
              : "equals",
      },
      diagnostic,
      computedValue: left.propellantMassKg,
      claimedValue: right.propellantMassKg,
      units: { mass: "kg", velocity: "m/s", isp: "s", g0: "m/s^2" },
      tolerance: null,
    };
  } catch (error) {
    const message = error instanceof CalculationError || error instanceof Error ? error.message : "calculation failed";
    return fail(
      { request },
      message,
      {
        claimedValue:
          request.kind === "expression"
            ? request.claimedValue
            : request.kind === "tsiolkovsky_propellant_mass"
              ? request.claimedPropellantMassKg
              : null,
      },
    );
  }
}

export type { TsiolkovskyPropellantResult };
