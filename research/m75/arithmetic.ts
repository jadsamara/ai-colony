import { createHash } from "node:crypto";
import { GENERATOR_VERSION, PROMPT_PREFIX, type TaskCell } from "./protocol.js";

export type Operator = "+" | "-" | "*";

export interface Problem {
  itemId: string;
  split: string;
  canonical: string;
  expected: number;
  operands: number[];
  operators: Operator[];
  termCount: number;
  templateKey: string;
  difficultyKey: string;
  prompt: string;
  generatorVersion: typeof GENERATOR_VERSION;
}

export function promptFor(canonical: string): string {
  return `${PROMPT_PREFIX}${canonical}`;
}

export function expressionFromPrompt(prompt: string): string | null {
  const marker = "\nExpression: ";
  const index = prompt.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const canonical = prompt.slice(index + marker.length).trim();
  return canonical.length > 0 ? canonical : null;
}

export function parseExpression(canonical: string): { operands: number[]; operators: Operator[] } {
  if (!/^\d+(?: [+\-*] \d+)+$/.test(canonical)) {
    throw new Error(`invalid expression: ${canonical}`);
  }
  const parts = canonical.split(" ");
  const operands: number[] = [];
  const operators: Operator[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      throw new Error(`invalid expression: ${canonical}`);
    }
    if (index % 2 === 0) {
      operands.push(Number(part));
    } else if (part === "+" || part === "-" || part === "*") {
      operators.push(part);
    } else {
      throw new Error(`invalid expression: ${canonical}`);
    }
  }
  return { operands, operators };
}

/** Multiplication binds tighter than addition and subtraction. Addition and subtraction associate left to right. */
export function evaluateExpression(canonical: string): number {
  const { operands, operators } = parseExpression(canonical);
  const terms: number[] = [];
  const additive: Array<"+" | "-"> = [];
  let current = operands[0];
  if (current === undefined) {
    throw new Error(`invalid expression: ${canonical}`);
  }
  for (let index = 0; index < operators.length; index += 1) {
    const operator = operators[index];
    const next = operands[index + 1];
    if (operator === undefined || next === undefined) {
      throw new Error(`invalid expression: ${canonical}`);
    }
    if (operator === "*") {
      current *= next;
    } else {
      terms.push(current);
      additive.push(operator);
      current = next;
    }
  }
  terms.push(current);
  let value = terms[0];
  if (value === undefined) {
    throw new Error(`invalid expression: ${canonical}`);
  }
  for (let index = 0; index < additive.length; index += 1) {
    const operator = additive[index];
    const term = terms[index + 1];
    if (operator === undefined || term === undefined) {
      throw new Error(`invalid expression: ${canonical}`);
    }
    value = operator === "+" ? value + term : value - term;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`expression result is not a safe integer: ${canonical}`);
  }
  return value;
}

export function templateKey(operators: Operator[], operands: number[]): string {
  return `${operators.join(",")}:${operands.join(",")}`;
}

export function difficultyKey(termCount: number, operators: Operator[], operands: number[]): string {
  const maxOperand = Math.max(...operands);
  const band = maxOperand <= 20 ? "1-20" : maxOperand <= 99 ? "21-99" : maxOperand <= 999 ? "100-999" : "1000+";
  return `${termCount}|${operators.join("")}|${band}`;
}

export function problemId(split: string, canonical: string): string {
  return createHash("sha256").update(`${GENERATOR_VERSION}|${split}|${canonical}`).digest("hex");
}

export function manifestHash(problems: Problem[]): string {
  const body = problems.map((problem) => `${problem.itemId}|${problem.canonical}|${problem.expected}`).join("\n");
  return createHash("sha256").update(body).digest("hex");
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function integer(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function generateProblems(
  cell: TaskCell,
  split: string,
  count: number,
  seed: number,
  forbidden: { canonicals: Set<string>; templates: Set<string> } = { canonicals: new Set(), templates: new Set() },
): Problem[] {
  if (count <= 0 || cell.termCount < 2 || cell.operandMin > cell.operandMax || cell.operators.length === 0) {
    throw new Error("problem generator configuration is invalid");
  }
  const random = mulberry32(seed);
  const problems: Problem[] = [];
  const seenCanonicals = new Set(forbidden.canonicals);
  const seenTemplates = new Set(forbidden.templates);
  const maxAttempts = count * 200;
  for (let attempt = 0; attempt < maxAttempts && problems.length < count; attempt += 1) {
    const operands: number[] = [];
    const operators: Operator[] = [];
    for (let index = 0; index < cell.termCount; index += 1) {
      operands.push(integer(random, cell.operandMin, cell.operandMax));
      if (index > 0) {
        const choice = cell.operators[integer(random, 0, cell.operators.length - 1)];
        if (choice === undefined) {
          throw new Error("operator sample was empty");
        }
        operators.push(choice);
      }
    }
    const canonical = operands.map((operand, index) => (index === 0 ? String(operand) : `${operators[index - 1]} ${operand}`)).join(" ");
    const key = templateKey(operators, operands);
    if (seenCanonicals.has(canonical) || seenTemplates.has(key)) {
      continue;
    }
    const expected = evaluateExpression(canonical);
    seenCanonicals.add(canonical);
    seenTemplates.add(key);
    problems.push({
      itemId: problemId(split, canonical),
      split,
      canonical,
      expected,
      operands,
      operators,
      termCount: cell.termCount,
      templateKey: key,
      difficultyKey: difficultyKey(cell.termCount, operators, operands),
      prompt: promptFor(canonical),
      generatorVersion: GENERATOR_VERSION,
    });
  }
  if (problems.length !== count) {
    throw new Error(`generator produced ${problems.length} of ${count} unique problems for ${split}`);
  }
  return problems;
}

export function assertDisjoint(groups: Problem[][]): void {
  const canonicals = new Set<string>();
  const templates = new Set<string>();
  for (const group of groups) {
    for (const problem of group) {
      if (canonicals.has(problem.canonical) || templates.has(problem.templateKey)) {
        throw new Error(`split leakage at ${problem.canonical}`);
      }
      canonicals.add(problem.canonical);
      templates.add(problem.templateKey);
    }
  }
}

export function oodCell(cell: TaskCell): TaskCell {
  if (cell.termCount < 5) {
    return { ...cell, id: `${cell.id}-ood-longer`, termCount: cell.termCount + 1 };
  }
  return { ...cell, id: `${cell.id}-ood-wider`, operandMax: Math.min(9999, cell.operandMax * 5) };
}
