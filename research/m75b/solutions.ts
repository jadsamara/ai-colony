import { evaluateExpression, parseExpression, type Operator } from "../m75/arithmetic.js";

export interface SolutionStep {
  expression: string;
  value: number;
}

/** Independently recomputed intermediate equations. Multiplication is reduced before addition and subtraction. */
export function structuredSteps(canonical: string): SolutionStep[] {
  const { operands, operators } = parseExpression(canonical);
  const steps: SolutionStep[] = [];
  const terms: number[] = [];
  const additive: Array<"+" | "-"> = [];
  const first = operands[0];
  if (first === undefined) {
    throw new Error("empty expression");
  }
  let current: number = first;
  let currentText = String(first);
  for (let index = 0; index < operators.length; index += 1) {
    const operator = operators[index];
    const next = operands[index + 1];
    if (operator === undefined || next === undefined) {
      throw new Error("broken expression");
    }
    if (operator === "*") {
      const value = current * next;
      steps.push({ expression: `${currentText} * ${next}`, value });
      current = value;
      currentText = String(value);
    } else {
      terms.push(current);
      additive.push(operator);
      current = next;
      currentText = String(next);
    }
  }
  terms.push(current);
  const firstTerm = terms[0];
  if (firstTerm === undefined) {
    throw new Error("empty expression");
  }
  let running: number = firstTerm;
  let shown = String(firstTerm);
  for (let index = 0; index < additive.length; index += 1) {
    const operator: Operator | undefined = additive[index];
    const term = terms[index + 1];
    if (operator === undefined || term === undefined || (operator !== "+" && operator !== "-")) {
      throw new Error("broken expression");
    }
    const value = operator === "+" ? running + term : running - term;
    steps.push({ expression: `${shown} ${operator} ${term}`, value });
    running = value;
    shown = String(value);
  }
  if (steps.length === 0) {
    steps.push({ expression: canonical, value: evaluateExpression(canonical) });
  }
  const final = steps[steps.length - 1];
  if (final === undefined || final.value !== evaluateExpression(canonical)) {
    throw new Error("structured solution does not match the expression");
  }
  return steps;
}

export function structuredTarget(canonical: string): string {
  return structuredSteps(canonical).map((step) => `${step.expression} = ${step.value}`).join("\n");
}

export function lossSpanRejectsPrompt(decodedLossSpan: string): boolean {
  return !decodedLossSpan.includes("Expression:");
}
