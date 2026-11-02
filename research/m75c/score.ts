export const DIAGNOSTIC_EXTRACTOR = "final-answer-then-last-integer-v1";

export type ResponseClass = "worked" | "bare" | "unparseable" | "other";
export type ExtractMethod = "final-answer" | "last-integer" | "none";

const FINAL_ANSWER = /Final answer:\s*([+-]?\d+)/i;
const INTEGER = /[+-]?\d+/g;

export function extractDiagnostic(response: string): { value: number | null; method: ExtractMethod } {
  const labeled = FINAL_ANSWER.exec(response);
  const labeledValue = labeled?.[1];
  if (labeledValue !== undefined && isIntegerToken(labeledValue)) {
    return { value: Number(labeledValue), method: "final-answer" };
  }
  const matches = response.match(INTEGER) ?? [];
  const last = matches[matches.length - 1];
  if (last !== undefined && isIntegerToken(last)) {
    return { value: Number(last), method: "last-integer" };
  }
  return { value: null, method: "none" };
}

export function classifyResponse(response: string): ResponseClass {
  const trimmed = response.trim();
  if (/^[+-]?\d+$/.test(trimmed)) {
    return "bare";
  }
  if (!INTEGER.test(trimmed)) {
    INTEGER.lastIndex = 0;
    return "unparseable";
  }
  INTEGER.lastIndex = 0;
  if (/=/.test(trimmed) || /\d\s*[+*]/.test(trimmed) || /[+*]\s*-?\d/.test(trimmed) || /\d\s+-\s+\d/.test(trimmed) || /\\times|\\cdot/.test(trimmed) || /step by step/i.test(trimmed)) {
    return "worked";
  }
  return "other";
}

export interface PairFlip {
  sampleSize: number;
  bothCorrect: number;
  firstOnly: number;
  secondOnly: number;
  neither: number;
  changedResponses: number;
}

export function pairFlips(firstCorrect: boolean[], secondCorrect: boolean[], firstText?: string[], secondText?: string[]): PairFlip {
  if (firstCorrect.length !== secondCorrect.length || firstCorrect.length === 0) {
    throw new Error("paired comparison requires equal non-empty lists");
  }
  let bothCorrect = 0;
  let firstOnly = 0;
  let secondOnly = 0;
  let neither = 0;
  let changedResponses = 0;
  for (let index = 0; index < firstCorrect.length; index += 1) {
    const left = firstCorrect[index] === true;
    const right = secondCorrect[index] === true;
    if (left && right) bothCorrect += 1;
    else if (left) firstOnly += 1;
    else if (right) secondOnly += 1;
    else neither += 1;
    if (firstText !== undefined && secondText !== undefined && firstText[index] !== secondText[index]) {
      changedResponses += 1;
    }
  }
  return { sampleSize: firstCorrect.length, bothCorrect, firstOnly, secondOnly, neither, changedResponses };
}

export function recovery(input: { base: number; candidate: number; candidateReference: number; sampleSize: number }): {
  points: number;
  fractionOfLossRecovered: number | null;
  remainsBelowBase: boolean;
} {
  const points = (input.candidate - input.candidateReference) / input.sampleSize;
  const loss = input.base - input.candidateReference;
  return {
    points,
    fractionOfLossRecovered: loss > 0 ? (input.candidate - input.candidateReference) / loss : null,
    remainsBelowBase: input.candidate < input.base,
  };
}

export function formatCompliant(response: string, prompt: "a" | "b"): boolean {
  if (prompt === "b") {
    return FINAL_ANSWER.test(response);
  }
  return /^[+-]?\d+$/.test(response.trim());
}

function isIntegerToken(value: string): boolean {
  if (!/^[+-]?\d+$/.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed);
}
