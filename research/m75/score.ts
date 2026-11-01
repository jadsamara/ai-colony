import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateExpression, expressionFromPrompt } from "./arithmetic.js";
import { scoreExact, scoreInteger } from "./extract.js";
import { expectedFromRetentionPrompt } from "./retention.js";
import { concludeResearch, phase1Decision, survivesBonferroni } from "./analysis.js";
import { pairedComparison, wilsonInterval } from "./stats.js";
import { GENERATOR_VERSION, SCORER_VERSION } from "./protocol.js";

export interface StoredEval {
  experimentId: string;
  evaluationRunId: string;
  itemId: string;
  split: string;
  datasetVersion: string;
  prompt: string;
  response: string;
  expectedAnswer: number | string;
  category?: string;
  scoreMode: "integer" | "exact";
  modelId: string;
  modelRevision: string;
  adapterId: string | null;
  adapterSha256: string | null;
  seed: number;
  decoding: unknown;
  attemptId: string;
  correct?: boolean;
  formatValid?: boolean;
}

export interface RescoredItem {
  itemId: string;
  correct: boolean;
  formatValid: boolean;
  exactFormat: boolean;
  extracted: number | string | null;
  expected: number | string;
  difficultyKey: string | null;
  storedCorrectMatched: boolean | null;
}

export function independentExpected(record: StoredEval): number | string {
  if (record.category === "record-extraction" || record.category === "exact-copy") {
    const derived = expectedFromRetentionPrompt(record.category, record.prompt);
    if (derived !== record.expectedAnswer) {
      throw new Error(`retention expected answer does not match the prompt for ${record.itemId}`);
    }
    return derived;
  }
  const canonical = expressionFromPrompt(record.prompt);
  if (canonical === null) {
    throw new Error(`arithmetic prompt has no expression for ${record.itemId}`);
  }
  const derived = evaluateExpression(canonical);
  if (derived !== record.expectedAnswer) {
    throw new Error(`stored expected answer does not match the expression for ${record.itemId}`);
  }
  return derived;
}

export function rescoreRecord(record: StoredEval): RescoredItem {
  const expected = independentExpected(record);
  if (record.scoreMode === "exact") {
    const scored = scoreExact(record.response, String(expected));
    return {
      itemId: record.itemId,
      correct: scored.correct,
      formatValid: scored.formatValid,
      exactFormat: scored.formatValid,
      extracted: scored.extracted,
      expected,
      difficultyKey: null,
      storedCorrectMatched: typeof record.correct === "boolean" ? record.correct === scored.correct : null,
    };
  }
  const scored = scoreInteger(record.response, Number(expected));
  return {
    itemId: record.itemId,
    correct: scored.correct,
    formatValid: scored.formatValid,
    exactFormat: scored.exactFormat,
    extracted: scored.extracted,
    expected,
    difficultyKey: null,
    storedCorrectMatched: typeof record.correct === "boolean" ? record.correct === scored.correct : null,
  };
}

export function summarizeRun(records: StoredEval[]): {
  evaluationRunId: string;
  sampleSize: number;
  taskCorrect: number;
  taskAccuracy: number;
  formatValid: number;
  formatAccuracy: number;
  exactFormat: number;
  interval: { low: number; high: number };
  invalid: string | null;
} {
  const scored: RescoredItem[] = [];
  let invalid: string | null = null;
  for (const record of records) {
    try {
      scored.push(rescoreRecord(record));
    } catch (error) {
      invalid = error instanceof Error ? error.message : "record failed independent scoring";
      break;
    }
  }
  const sampleSize = scored.length;
  const taskCorrect = scored.filter((item) => item.correct).length;
  const formatValid = scored.filter((item) => item.formatValid).length;
  const exactFormat = scored.filter((item) => item.exactFormat).length;
  return {
    evaluationRunId: records[0]?.evaluationRunId ?? "empty",
    sampleSize,
    taskCorrect,
    taskAccuracy: sampleSize === 0 ? 0 : taskCorrect / sampleSize,
    formatValid,
    formatAccuracy: sampleSize === 0 ? 0 : formatValid / sampleSize,
    exactFormat,
    interval: wilsonInterval(taskCorrect, sampleSize),
    invalid,
  };
}

export function compareRuns(baseline: StoredEval[], candidate: StoredEval[], retentionDrop: boolean): {
  comparison: ReturnType<typeof pairedComparison> | null;
  conclusion: ReturnType<typeof concludeResearch>;
  bonferroni: boolean;
  deployment: ReturnType<typeof phase1Decision>;
  limitations: string;
} {
  if (baseline.length === 0 || baseline.length !== candidate.length || baseline.some((item, index) => item.itemId !== candidate[index]?.itemId)) {
    const decision = phase1Decision("EVALUATION_INVALID");
    return {
      comparison: null,
      conclusion: "EVALUATION_INVALID",
      bonferroni: false,
      deployment: decision,
      limitations: "Paired items were missing or misaligned, so no significance claim is made.",
    };
  }
  let baselineCorrect: boolean[] = [];
  let candidateCorrect: boolean[] = [];
  try {
    baselineCorrect = baseline.map((record) => rescoreRecord(record).correct);
    candidateCorrect = candidate.map((record) => rescoreRecord(record).correct);
  } catch (error) {
    const decision = phase1Decision("EVALUATION_INVALID");
    return {
      comparison: null,
      conclusion: "EVALUATION_INVALID",
      bonferroni: false,
      deployment: decision,
      limitations: error instanceof Error ? error.message : "scoring failed",
    };
  }
  const comparison = pairedComparison(baselineCorrect, candidateCorrect);
  const conclusion = concludeResearch({
    valid: true,
    retentionFailed: retentionDrop,
    difference: comparison.difference,
    pValue: comparison.pValue,
    sampleSize: comparison.sampleSize,
  });
  return {
    comparison,
    conclusion,
    bonferroni: survivesBonferroni(comparison.pValue),
    deployment: phase1Decision(conclusion),
    limitations: `Exact McNemar treats items as independent and is not a multiple-comparison correction. Bonferroni alpha for ${6} confirmatory tests is ${0.05 / 6}. Generator ${GENERATOR_VERSION}, scorer ${SCORER_VERSION}. Wilson separation is not required for this research conclusion. A positive research conclusion does not authorize deployment.`,
  };
}

export function loadEvalFiles(directory: string): Map<string, StoredEval[]> {
  const grouped = new Map<string, StoredEval[]>();
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".jsonl")).sort()) {
    const text = readFileSync(join(directory, name), "utf8").trim();
    if (text.length === 0) {
      continue;
    }
    for (const line of text.split("\n")) {
      const record = JSON.parse(line) as StoredEval;
      const list = grouped.get(record.evaluationRunId) ?? [];
      list.push(record);
      grouped.set(record.evaluationRunId, list);
    }
  }
  return grouped;
}

function main(): void {
  const directory = process.argv[2];
  if (directory === undefined) {
    throw new Error("usage: tsx research/m75/score.ts <eval-directory>");
  }
  const grouped = loadEvalFiles(directory);
  const summaries = [...grouped.values()].map((records) => summarizeRun(records));
  process.stdout.write(`${JSON.stringify({ scorerVersion: SCORER_VERSION, summaries }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
