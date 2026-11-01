import { SCORER_VERSION } from "./protocol.js";

export interface IntegerScore {
  scorerVersion: typeof SCORER_VERSION;
  extracted: number | null;
  exactFormat: boolean;
  formatValid: boolean;
  ambiguous: boolean;
  correct: boolean;
}

const INTEGER = /[+-]?\d+/g;

/** Last integer is the task answer. A bare integer is exact format. An equation can still be task-correct. */
export function scoreInteger(response: string, expected: number): IntegerScore {
  const trimmed = response.trim();
  const exactFormat = /^[+-]?\d+$/.test(trimmed);
  const matches = trimmed.match(INTEGER) ?? [];
  const last = matches[matches.length - 1];
  if (last === undefined || !/^[+-]?\d+$/.test(last)) {
    return { scorerVersion: SCORER_VERSION, extracted: null, exactFormat: false, formatValid: false, ambiguous: false, correct: false };
  }
  const extracted = Number(last);
  if (!Number.isSafeInteger(extracted)) {
    return { scorerVersion: SCORER_VERSION, extracted: null, exactFormat: false, formatValid: false, ambiguous: false, correct: false };
  }
  return {
    scorerVersion: SCORER_VERSION,
    extracted,
    exactFormat,
    formatValid: true,
    ambiguous: matches.length > 1 && !exactFormat,
    correct: extracted === expected,
  };
}

export function scoreExact(response: string, expected: string): { correct: boolean; formatValid: boolean; extracted: string } {
  const extracted = response.trim();
  const correct = extracted === expected;
  return { correct, formatValid: correct, extracted };
}
