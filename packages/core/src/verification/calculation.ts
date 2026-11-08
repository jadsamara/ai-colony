/**
 * Deterministic, allowlisted calculator for claim verification.
 * No eval, no shell, no arbitrary code execution.
 */

export const STANDARD_GRAVITY_M_S2 = 9.80665;

export const CALC_CONSTANTS = {
  g0: STANDARD_GRAVITY_M_S2,
} as const;

export type CalcConstantName = keyof typeof CALC_CONSTANTS;

export type CalcNode =
  | { kind: "literal"; value: number }
  | { kind: "constant"; name: CalcConstantName }
  | { kind: "add" | "sub" | "mul" | "div"; left: CalcNode; right: CalcNode }
  | { kind: "pow"; base: CalcNode; exponent: CalcNode }
  | { kind: "exp" | "ln" | "log10" | "neg" | "abs"; arg: CalcNode };

const MAX_DEPTH = 32;

export class CalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalculationError";
  }
}

function assertFinite(value: number, context: string): number {
  if (!Number.isFinite(value)) {
    throw new CalculationError(`${context} is not finite`);
  }
  return value;
}

export function evaluateCalc(node: CalcNode, depth = 0): number {
  if (depth > MAX_DEPTH) {
    throw new CalculationError("expression exceeded maximum depth");
  }
  switch (node.kind) {
    case "literal":
      return assertFinite(node.value, "literal");
    case "constant": {
      const value = CALC_CONSTANTS[node.name];
      if (value === undefined) {
        throw new CalculationError(`unknown constant: ${String(node.name)}`);
      }
      return value;
    }
    case "add":
      return assertFinite(evaluateCalc(node.left, depth + 1) + evaluateCalc(node.right, depth + 1), "add");
    case "sub":
      return assertFinite(evaluateCalc(node.left, depth + 1) - evaluateCalc(node.right, depth + 1), "sub");
    case "mul":
      return assertFinite(evaluateCalc(node.left, depth + 1) * evaluateCalc(node.right, depth + 1), "mul");
    case "div": {
      const right = evaluateCalc(node.right, depth + 1);
      if (right === 0) {
        throw new CalculationError("division by zero");
      }
      return assertFinite(evaluateCalc(node.left, depth + 1) / right, "div");
    }
    case "pow": {
      const base = evaluateCalc(node.base, depth + 1);
      const exponent = evaluateCalc(node.exponent, depth + 1);
      if (base < 0 && !Number.isInteger(exponent)) {
        throw new CalculationError("negative base with non-integer exponent is not allowed");
      }
      return assertFinite(base ** exponent, "pow");
    }
    case "exp":
      return assertFinite(Math.exp(evaluateCalc(node.arg, depth + 1)), "exp");
    case "ln": {
      const arg = evaluateCalc(node.arg, depth + 1);
      if (arg <= 0) {
        throw new CalculationError("ln requires a positive argument");
      }
      return assertFinite(Math.log(arg), "ln");
    }
    case "log10": {
      const arg = evaluateCalc(node.arg, depth + 1);
      if (arg <= 0) {
        throw new CalculationError("log10 requires a positive argument");
      }
      return assertFinite(Math.log10(arg), "log10");
    }
    case "neg":
      return assertFinite(-evaluateCalc(node.arg, depth + 1), "neg");
    case "abs":
      return assertFinite(Math.abs(evaluateCalc(node.arg, depth + 1)), "abs");
    default: {
      const _exhaustive: never = node;
      throw new CalculationError(`unsupported node: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export interface TsiolkovskyPropellantInput {
  dryMassKg: number;
  deltaV_m_s: number;
  isp_s: number;
  /** Defaults to standard gravity (9.80665 m/s²). */
  g0_m_s2?: number;
}

export interface TsiolkovskyPropellantResult {
  formula: "tsiolkovsky_propellant_mass";
  dryMassKg: number;
  deltaV_m_s: number;
  isp_s: number;
  g0_m_s2: number;
  exhaustVelocity_m_s: number;
  massRatio: number;
  propellantMassKg: number;
  equation: string;
}

/**
 * Rocket equation with final (dry) mass held fixed:
 * m_propellant = m_dry * (exp(Δv / (Isp * g0)) - 1)
 */
export function tsiolkovskyPropellantMass(input: TsiolkovskyPropellantInput): TsiolkovskyPropellantResult {
  const dryMassKg = assertFinite(input.dryMassKg, "dryMassKg");
  const deltaV_m_s = assertFinite(input.deltaV_m_s, "deltaV_m_s");
  const isp_s = assertFinite(input.isp_s, "isp_s");
  const g0_m_s2 = assertFinite(input.g0_m_s2 ?? STANDARD_GRAVITY_M_S2, "g0_m_s2");
  if (dryMassKg <= 0) {
    throw new CalculationError("dryMassKg must be positive");
  }
  if (deltaV_m_s < 0) {
    throw new CalculationError("deltaV_m_s must be non-negative");
  }
  if (isp_s <= 0) {
    throw new CalculationError("isp_s must be positive");
  }
  if (g0_m_s2 <= 0) {
    throw new CalculationError("g0_m_s2 must be positive");
  }
  const node: CalcNode = {
    kind: "mul",
    left: { kind: "literal", value: dryMassKg },
    right: {
      kind: "sub",
      left: {
        kind: "exp",
        arg: {
          kind: "div",
          left: { kind: "literal", value: deltaV_m_s },
          right: {
            kind: "mul",
            left: { kind: "literal", value: isp_s },
            right: { kind: "literal", value: g0_m_s2 },
          },
        },
      },
      right: { kind: "literal", value: 1 },
    },
  };
  const propellantMassKg = evaluateCalc(node);
  const exhaustVelocity_m_s = isp_s * g0_m_s2;
  const massRatio = Math.exp(deltaV_m_s / exhaustVelocity_m_s);
  return {
    formula: "tsiolkovsky_propellant_mass",
    dryMassKg,
    deltaV_m_s,
    isp_s,
    g0_m_s2,
    exhaustVelocity_m_s,
    massRatio,
    propellantMassKg,
    equation: "m_p = m_dry * (exp(delta_v / (Isp * g0)) - 1)",
  };
}
