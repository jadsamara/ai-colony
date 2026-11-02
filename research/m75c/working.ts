import { evaluateExpression } from "../m75/arithmetic.js";

export type WorkingVerdict = "correct-parseable" | "incorrect-arithmetic" | "unparseable-working" | "ambiguous" | "missing-working";

export interface WorkingAssessment {
  verdict: WorkingVerdict;
  chains: number;
  detail: string;
}

/** A chain such as `6 * 8 + 15 = 48 + 15 = 63` is checked piece by piece. */
export function assessWorking(response: string, expected: number): WorkingAssessment {
  const body = response
    .split("\n")
    .filter((line) => !/^\s*(final answer|integer result)\s*:/i.test(line))
    .join("\n");
  const chains = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("="));
  if (chains.length === 0) {
    return { verdict: "missing-working", chains: 0, detail: "no equality was found" };
  }
  let incorrect = 0;
  let unparseable = 0;
  const consistent: number[] = [];
  for (const chain of chains) {
    const pieces = chain.split("=").map((piece) => piece.trim()).filter((piece) => piece.length > 0);
    const values: number[] = [];
    let failed = false;
    for (const piece of pieces) {
      const value = tryEvaluate(piece);
      if (value === null) {
        failed = true;
        break;
      }
      values.push(value);
    }
    if (failed || values.length < 2) {
      unparseable += 1;
      continue;
    }
    const first = values[0];
    if (first === undefined || values.some((value) => value !== first)) {
      incorrect += 1;
      continue;
    }
    consistent.push(first);
  }
  const claimed = consistent[consistent.length - 1];
  if (incorrect > 0 && (consistent.length > 0 || unparseable > 0)) {
    return { verdict: "ambiguous", chains: chains.length, detail: `${incorrect} internally inconsistent chains` };
  }
  if (incorrect > 0) {
    return { verdict: "incorrect-arithmetic", chains: chains.length, detail: `${incorrect} chains disagree internally` };
  }
  if (claimed === expected && unparseable === 0) {
    return { verdict: "correct-parseable", chains: chains.length, detail: `last chain equals ${expected}` };
  }
  if (claimed === expected && unparseable > 0) {
    return { verdict: "ambiguous", chains: chains.length, detail: "the last readable chain is correct and other lines could not be parsed" };
  }
  if (claimed !== undefined && unparseable > 0) {
    return { verdict: "ambiguous", chains: chains.length, detail: "readable lines do not settle the answer and other lines could not be parsed" };
  }
  if (claimed !== undefined) {
    return { verdict: "incorrect-arithmetic", chains: chains.length, detail: `last readable chain equals ${claimed}, expected ${expected}` };
  }
  return { verdict: "unparseable-working", chains: chains.length, detail: "equality signs were present but no chain could be evaluated" };
}

function tryEvaluate(piece: string): number | null {
  const normalized = piece
    .replace(/\\times|\\cdot/g, "*")
    .replace(/×/g, "*")
    .replace(/[−–]/g, "-")
    .replace(/\*\*/g, "")
    .replace(/[$`]/g, "")
    .replace(/([+*])/g, " $1 ")
    .replace(/(?<=\d)\s*-\s*(?=\d)/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^[+-]?\d+$/.test(normalized)) {
    const literal = Number(normalized);
    return Number.isSafeInteger(literal) ? literal : null;
  }
  const expression = normalized.startsWith("-") ? `0 - ${normalized.slice(1).trim()}` : normalized;
  if (!/^\d+(?:\s+[+*\-]\s+[+-]?\d+)+$/.test(expression)) {
    return null;
  }
  try {
    const value = evaluateExpression(expression);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}
