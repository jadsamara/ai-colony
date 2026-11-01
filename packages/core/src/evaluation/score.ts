const INTEGER = /^-?(?:0|[1-9]\d*)$/;
const EQUATION = /^([^=\n]+)=\s*(-?(?:0|[1-9]\d*))\s*$/;

export interface ArithmeticGrade {
  exactMatch: boolean;
  strictIntegerMatch: boolean;
  formatValid: boolean;
  equationValue: string | null;
  ambiguous: boolean;
  taskCorrect: boolean;
}

/**
 * Strict integers and one equation form (`left = integer`) are scored separately.
 * A well-formed wrong integer is format-valid and task-incorrect.
 * Text that merely contains a number is ambiguous and is not given task credit.
 */
export function gradeArithmetic(expected: string, raw: string): ArithmeticGrade {
  const text = raw.trim();
  const target = expected.trim();
  const strict = INTEGER.test(text);
  const equation = EQUATION.exec(text);
  const equationValue = equation?.[2] ?? null;
  const ambiguous = equationValue === null && text.includes("=");
  const formatValid = strict || (equationValue !== null && !ambiguous);
  const taskCorrect =
    !ambiguous && ((strict && text === target) || (!strict && equationValue !== null && equationValue === target));
  return {
    exactMatch: text === target,
    strictIntegerMatch: strict && text === target,
    formatValid,
    equationValue,
    ambiguous,
    taskCorrect,
  };
}

export interface PairedItem {
  ordinal: number;
  expected: string;
  baseline: string;
  candidate: string;
  baselineGrade: ArithmeticGrade;
  candidateGrade: ArithmeticGrade;
}

export function gradePair(ordinal: number, expected: string, baseline: string, candidate: string): PairedItem {
  return {
    ordinal,
    expected,
    baseline,
    candidate,
    baselineGrade: gradeArithmetic(expected, baseline),
    candidateGrade: gradeArithmetic(expected, candidate),
  };
}
