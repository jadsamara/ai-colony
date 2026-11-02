import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scoreInteger } from "../m75/extract.js";
import { loadEvalFiles, summarizeRun, type StoredEval } from "../m75/score.js";
import { assessWorking, type WorkingVerdict } from "./working.js";
import { classifyResponse, extractDiagnostic, formatCompliant, pairFlips, recovery, type ResponseClass } from "./score.js";
import { selectIds } from "./sample.js";

const ROOT = join(import.meta.dirname, "../..");
const PHASE = join(ROOT, "services/training/results/m75c/phase1a");
const GENERATIONS = join(PHASE, "generations");
const INSPECTION_SEED = 7501;
const INSPECTION_ADAPTER = "self-101-r1";
const INSPECTION_COUNT = 20;

const M75_EXPECTED: Record<string, number> = {
  "baseline-sealed": 134,
  "self-101-r1-sealed": 27,
  "supervised-101-sealed": 37,
  "self-202-r1-sealed": 38,
  "supervised-202-sealed": 29,
  "self-303-r1-sealed": 33,
  "supervised-303-sealed": 54,
};

const M75B_EXPECTED: Record<string, number> = {
  "baseline-sealed": 138,
  "structured-s5-n25-sealed": 139,
  "structured-s5-n25-seed-202-sealed": 139,
  "structured-s5-n25-seed-303-sealed": 139,
};

const COMPARISON_MODELS = [
  "base",
  "self-101-r1",
  "supervised-101",
  "self-202-r1",
  "supervised-202",
  "self-303-r1",
  "supervised-303",
  "structured-s5-n25",
  "structured-s5-n25-seed-202",
  "structured-s5-n25-seed-303",
];

const VERDICTS: WorkingVerdict[] = ["correct-parseable", "incorrect-arithmetic", "unparseable-working", "ambiguous", "missing-working"];

interface GeneratedRow {
  model: string;
  condition: string;
  promptName: "a" | "b";
  maxTokens: number;
  itemId: string;
  prompt: string;
  response: string;
  expectedAnswer: number;
  historicalResponse?: string;
  finishReason: string;
  completionTokens: number;
  truncated: boolean;
}

interface ScoredRow {
  itemId: string;
  expectedAnswer: number;
  response: string;
  responseClass: ResponseClass;
  extracted: number | null;
  extractMethod: string;
  correct: boolean;
  formatCompliant: boolean;
  characters: number;
  completionTokens: number;
  truncated: boolean;
  working: WorkingVerdict;
  historicalResponse: string | null;
  byteMatch: boolean | null;
}

function readJsonl<T>(path: string): T[] {
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) {
    return [];
  }
  return text.split("\n").map((line) => JSON.parse(line) as T);
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(PHASE, name), `${JSON.stringify(value, null, 2)}\n`);
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emptyClasses(): Record<ResponseClass, number> {
  return { worked: 0, bare: 0, unparseable: 0, other: 0 };
}

function historicalMaxTokens(record: StoredEval): number {
  const decoding = record.decoding;
  if (typeof decoding === "object" && decoding !== null && "maxTokens" in decoding && typeof decoding.maxTokens === "number") {
    return decoding.maxTokens;
  }
  return 32;
}

function scoreHistorical(record: StoredEval & { completionTokens?: number }): ScoredRow {
  const scored = scoreInteger(record.response, Number(record.expectedAnswer));
  const diagnostic = extractDiagnostic(record.response);
  const storedTokens = record.completionTokens;
  return {
    itemId: record.itemId,
    expectedAnswer: Number(record.expectedAnswer),
    response: record.response,
    responseClass: classifyResponse(record.response),
    extracted: diagnostic.value,
    extractMethod: diagnostic.method,
    correct: scored.correct,
    formatCompliant: scored.exactFormat,
    characters: record.response.length,
    completionTokens: storedTokens ?? -1,
    truncated: storedTokens === undefined ? false : storedTokens >= historicalMaxTokens(record),
    working: assessWorking(record.response, Number(record.expectedAnswer)).verdict,
    historicalResponse: null,
    byteMatch: null,
  };
}

function scoreGenerated(row: GeneratedRow): ScoredRow {
  const diagnostic = extractDiagnostic(row.response);
  const correct = diagnostic.value !== null && diagnostic.value === row.expectedAnswer;
  return {
    itemId: row.itemId,
    expectedAnswer: row.expectedAnswer,
    response: row.response,
    responseClass: classifyResponse(row.response),
    extracted: diagnostic.value,
    extractMethod: diagnostic.method,
    correct,
    formatCompliant: formatCompliant(row.response, row.promptName),
    characters: row.response.length,
    completionTokens: row.completionTokens,
    truncated: row.truncated,
    working: assessWorking(row.response, row.expectedAnswer).verdict,
    historicalResponse: row.historicalResponse ?? null,
    byteMatch: row.historicalResponse == null ? null : row.response === row.historicalResponse,
  };
}

function tally(rows: ScoredRow[]): Record<string, unknown> {
  const classes = emptyClasses();
  const classCorrect = emptyClasses();
  const working = Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0])) as Record<WorkingVerdict, number>;
  for (const row of rows) {
    classes[row.responseClass] += 1;
    if (row.correct) {
      classCorrect[row.responseClass] += 1;
    }
    working[row.working] += 1;
  }
  const conditional = Object.fromEntries(
    (Object.keys(classes) as ResponseClass[]).map((name) => [
      name,
      { count: classes[name], correct: classCorrect[name], accuracy: classes[name] === 0 ? null : classCorrect[name] / classes[name] },
    ]),
  );
  const correct = rows.filter((row) => row.correct).length;
  const matches = rows.filter((row) => row.byteMatch !== null);
  return {
    sampleSize: rows.length,
    correct,
    accuracy: rows.length === 0 ? null : correct / rows.length,
    classes,
    classShare: Object.fromEntries((Object.keys(classes) as ResponseClass[]).map((name) => [name, rows.length === 0 ? null : classes[name] / rows.length])),
    conditionalAccuracy: conditional,
    formatCompliant: rows.filter((row) => row.formatCompliant).length,
    averageCharacters: average(rows.map((row) => row.characters)),
    averageTokens: average(rows.filter((row) => row.completionTokens >= 0).map((row) => row.completionTokens)),
    tokenCountsStored: rows.filter((row) => row.completionTokens >= 0).length,
    truncated: rows.filter((row) => row.truncated).length,
    truncationKnown: rows.every((row) => row.completionTokens >= 0),
    extractionFailures: rows.filter((row) => row.extractMethod === "none").length,
    working,
    byteMatches: matches.filter((row) => row.byteMatch === true).length,
    byteCompared: matches.length,
  };
}

function verifyHistory(): void {
  const checks = [
    { study: "m75", directory: join(ROOT, "services/training/results/m75/evals"), expected: M75_EXPECTED },
    { study: "m75b", directory: join(ROOT, "services/training/results/m75b/evals"), expected: M75B_EXPECTED },
  ];
  const results = checks.map((check) => {
    const grouped = loadEvalFiles(check.directory);
    return {
      study: check.study,
      runs: Object.entries(check.expected).map(([evaluationRunId, expectedCorrect]) => {
        const records = grouped.get(evaluationRunId);
        if (records === undefined) {
          return { evaluationRunId, expectedCorrect, observedCorrect: null, sampleSize: 0, discrepancy: true, invalid: "run missing" };
        }
        const summary = summarizeRun(records);
        return {
          evaluationRunId,
          expectedCorrect,
          observedCorrect: summary.taskCorrect,
          sampleSize: summary.sampleSize,
          discrepancy: summary.taskCorrect !== expectedCorrect || summary.sampleSize !== 300 || summary.invalid !== null,
          invalid: summary.invalid,
        };
      }),
    };
  });
  writeJson("historical-verification.json", { scorer: "answer-extract-m75-v1", results });
}

function historicalFormat(): void {
  const studies = ["m75", "m75b"].map((study) => {
    const grouped = loadEvalFiles(join(ROOT, `services/training/results/${study}/evals`));
    const runs = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([evaluationRunId, records]) => ({
      evaluationRunId,
      ...tally(records.map((record) => scoreHistorical(record))),
    }));
    return { study, runs };
  });
  writeJson("historical-format.json", { classifier: "worked-bare-unparseable-other-v1", studies });
}

function loadGenerated(model: string, condition: string): ScoredRow[] {
  const path = join(GENERATIONS, model, `${condition}.jsonl`);
  return readJsonl<GeneratedRow>(path).map((row) => scoreGenerated(row));
}

function generationComplete(): boolean {
  const expected: Record<string, number> = { "repro-a": 300, "sealed-a": 300, "sealed-b": 300, "dev-a": 48, "dev-b": 48 };
  return COMPARISON_MODELS.every((model) =>
    Object.entries(expected).every(([condition, count]) => {
      const path = join(GENERATIONS, model, `${condition}.jsonl`);
      try {
        return readJsonl<GeneratedRow>(path).length === count;
      } catch {
        return false;
      }
    }),
  );
}

function align(left: ScoredRow[], right: ScoredRow[]): { left: ScoredRow[]; right: ScoredRow[] } {
  const rightById = new Map(right.map((row) => [row.itemId, row]));
  const pairedLeft: ScoredRow[] = [];
  const pairedRight: ScoredRow[] = [];
  for (const row of left) {
    const match = rightById.get(row.itemId);
    if (match === undefined) {
      throw new Error(`missing paired item ${row.itemId}`);
    }
    pairedLeft.push(row);
    pairedRight.push(match);
  }
  if (pairedLeft.length !== right.length) {
    throw new Error("paired files do not contain the same items");
  }
  return { left: pairedLeft, right: pairedRight };
}

function analyzeGenerations(): void {
  if (!generationComplete()) {
    writeJson("generation-status.json", { complete: false });
    return;
  }
  const scoredDir = join(PHASE, "scored");
  mkdirSync(scoredDir, { recursive: true });
  const conditions = ["repro-a", "sealed-a", "sealed-b", "dev-a", "dev-b"] as const;
  const byModel = new Map<string, Record<string, ScoredRow[]>>();
  for (const model of COMPARISON_MODELS) {
    const rows: Record<string, ScoredRow[]> = {};
    for (const condition of conditions) {
      rows[condition] = loadGenerated(model, condition);
      writeFileSync(join(scoredDir, `${model}-${condition}.jsonl`), `${rows[condition].map((row) => JSON.stringify(row)).join("\n")}\n`);
    }
    byModel.set(model, rows);
  }
  const base = byModel.get("base");
  if (base === undefined) {
    throw new Error("base generations are missing");
  }
  const summaries = COMPARISON_MODELS.map((model) => {
    const rows = byModel.get(model);
    if (rows === undefined) {
      throw new Error(`missing ${model}`);
    }
    const promptPairs = [
      ["sealed-a", "sealed-b"],
      ["dev-a", "dev-b"],
    ] as const;
    const comparisons = promptPairs.map(([leftName, rightName]) => {
      const same = align(rows[leftName] ?? [], rows[rightName] ?? []);
      const versusBaseA = align(base[leftName] ?? [], rows[leftName] ?? []);
      const versusBaseB = align(base[rightName] ?? [], rows[rightName] ?? []);
      const candidateA = rows[leftName] ?? [];
      const candidateB = rows[rightName] ?? [];
      const baseARows = base[leftName] ?? [];
      const baseBRows = base[rightName] ?? [];
      const historical = leftName === "sealed-a" ? M75_EXPECTED[model === "base" ? "baseline-sealed" : `${model}-sealed`] : undefined;
      return {
        set: leftName.startsWith("sealed") ? "m75-sealed-diagnostic" : "m75-development-diagnostic",
        betweenPrompts: pairFlips(
          same.left.map((row) => row.correct),
          same.right.map((row) => row.correct),
          same.left.map((row) => row.response),
          same.right.map((row) => row.response),
        ),
        versusBasePromptA: pairFlips(
          versusBaseA.left.map((row) => row.correct),
          versusBaseA.right.map((row) => row.correct),
        ),
        versusBasePromptB: pairFlips(
          versusBaseB.left.map((row) => row.correct),
          versusBaseB.right.map((row) => row.correct),
        ),
        sameBudgetRecovery: recovery({
          base: baseBRows.filter((row) => row.correct).length,
          candidate: candidateB.filter((row) => row.correct).length,
          candidateReference: candidateA.filter((row) => row.correct).length,
          sampleSize: candidateA.length,
        }),
        promptADeficitRecovered: recovery({
          base: baseARows.filter((row) => row.correct).length,
          candidate: candidateB.filter((row) => row.correct).length,
          candidateReference: candidateA.filter((row) => row.correct).length,
          sampleSize: candidateA.length,
        }),
        historicalGap: historical === undefined ? null : recovery({
          base: M75_EXPECTED["baseline-sealed"] ?? 0,
          candidate: candidateB.filter((row) => row.correct).length,
          candidateReference: historical,
          sampleSize: 300,
        }),
      };
    });
    return {
      model,
      conditions: Object.fromEntries(conditions.map((condition) => [condition, tally(rows[condition] ?? [])])),
      comparisons,
    };
  });
  writeJson("two-prompt.json", {
    label: "DIAGNOSTIC",
    extractor: "final-answer-then-last-integer-v1",
    maxTokens: { reproA: 32, comparison: 128 },
    thinking: "closed-empty-prefill",
    decoding: { temperature: 0, topP: 1, seed: 0 },
    models: summaries,
  });
  writeQualitative(byModel);
  writeValidatorAudit(byModel);
  writeReproducibility(byModel);
  writeJson("generation-status.json", { complete: true });
}

function sourceResponses(model: string, study: "m75" | "m75b"): Map<string, string> {
  const file = model === "base" ? "baseline-sealed.jsonl" : `${model}-sealed.jsonl`;
  try {
    return new Map(readJsonl<StoredEval>(join(ROOT, "services/training/results", study, "evals", file)).map((row) => [row.itemId, row.response]));
  } catch {
    return new Map();
  }
}

function writeReproducibility(byModel: Map<string, Record<string, ScoredRow[]>>): void {
  const models = COMPARISON_MODELS.map((model) => {
    const study = model.startsWith("structured-") ? "m75b" : "m75";
    const history = sourceResponses(model, study);
    let reproExact = 0;
    let reproCompared = 0;
    for (const row of byModel.get(model)?.["repro-a"] ?? []) {
      const previous = history.get(row.itemId);
      if (previous === undefined) {
        continue;
      }
      reproCompared += 1;
      if (previous === row.response) {
        reproExact += 1;
      }
    }
    const sealedHistory = sourceResponses(model, "m75");
    let sealedExact = 0;
    let sealedPrefix = 0;
    let sealedCompared = 0;
    for (const row of byModel.get(model)?.["sealed-a"] ?? []) {
      const previous = sealedHistory.get(row.itemId);
      if (previous === undefined) {
        continue;
      }
      sealedCompared += 1;
      if (previous === row.response) {
        sealedExact += 1;
      }
      if (row.response.startsWith(previous) || previous.startsWith(row.response)) {
        sealedPrefix += 1;
      }
    }
    return { model, reproStudy: study, reproExact, reproCompared, sealedExact, sealedPrefix, sealedCompared };
  });
  writeJson("reproducibility.json", {
    reproDecoding: { temperature: 0, topP: 1, maxTokens: 32, seed: 0, thinking: "closed-empty-prefill" },
    models,
  });
}

function writeQualitative(byModel: Map<string, Record<string, ScoredRow[]>>): void {
  const baseA = byModel.get("base")?.["sealed-a"] ?? [];
  const adapterA = byModel.get(INSPECTION_ADAPTER)?.["sealed-a"] ?? [];
  const ids = selectIds(baseA.map((row) => row.itemId), INSPECTION_SEED, INSPECTION_COUNT);
  const examples = sideBySide(ids, byModel);
  const paired = align(adapterA, byModel.get(INSPECTION_ADAPTER)?.["sealed-b"] ?? []);
  const flipIds = paired.left.filter((row, index) => row.correct !== paired.right[index]?.correct).map((row) => row.itemId);
  const extraIds = selectIds(flipIds, INSPECTION_SEED, Math.min(INSPECTION_COUNT, flipIds.length));
  writeJson("qualitative.json", {
    seed: INSPECTION_SEED,
    adapter: INSPECTION_ADAPTER,
    selection: "sorted item ids, mulberry32 Fisher-Yates, first 20",
    itemIds: ids,
    examples,
    promptFlipCount: flipIds.length,
    promptFlipItemIds: extraIds,
    promptFlipExamples: sideBySide(extraIds, byModel),
  });
}

function sideBySide(ids: string[], byModel: Map<string, Record<string, ScoredRow[]>>): unknown[] {
  const lookup = (model: string, condition: string): Map<string, ScoredRow> => new Map((byModel.get(model)?.[condition] ?? []).map((row) => [row.itemId, row]));
  const baseA = lookup("base", "sealed-a");
  const baseB = lookup("base", "sealed-b");
  const adapterA = lookup(INSPECTION_ADAPTER, "sealed-a");
  const adapterB = lookup(INSPECTION_ADAPTER, "sealed-b");
  return ids.map((itemId) => {
    const cells = {
      baseA: baseA.get(itemId),
      baseB: baseB.get(itemId),
      adapterA: adapterA.get(itemId),
      adapterB: adapterB.get(itemId),
    };
    return {
      itemId,
      expectedAnswer: cells.baseA?.expectedAnswer ?? null,
      basePromptA: cell(cells.baseA),
      basePromptB: cell(cells.baseB),
      adapterPromptA: cell(cells.adapterA),
      adapterPromptB: cell(cells.adapterB),
    };
  });
}

function cell(row: ScoredRow | undefined): unknown {
  if (row === undefined) {
    return null;
  }
  return {
    response: row.response,
    extracted: row.extracted,
    correct: row.correct,
    responseClass: row.responseClass,
    working: row.working,
    truncated: row.truncated,
  };
}

function writeValidatorAudit(byModel: Map<string, Record<string, ScoredRow[]>>): void {
  const rejected: unknown[] = [];
  for (const model of COMPARISON_MODELS) {
    for (const condition of ["sealed-a", "sealed-b", "dev-a", "dev-b"]) {
      for (const row of byModel.get(model)?.[condition] ?? []) {
        if (!row.correct || row.working === "correct-parseable" || row.working === "missing-working") {
          continue;
        }
        rejected.push({
          model,
          condition,
          itemId: row.itemId,
          expectedAnswer: row.expectedAnswer,
          extracted: row.extracted,
          working: row.working,
          response: row.response,
        });
      }
    }
  }
  const rejectedByKey = new Map(rejected.map((row) => {
    const record = row as { model: string; condition: string; itemId: string };
    return [`${record.model}|${record.condition}|${record.itemId}`, row];
  }));
  const inspected = selectIds([...rejectedByKey.keys()], INSPECTION_SEED, Math.min(20, rejectedByKey.size)).map((key) => rejectedByKey.get(key));
  const counts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0])) as Record<WorkingVerdict, number>;
  for (const model of COMPARISON_MODELS) {
    for (const row of byModel.get(model)?.["sealed-b"] ?? []) {
      counts[row.working] += 1;
    }
  }
  writeJson("validator-audit.json", {
    sealedPromptBCounts: counts,
    finalCorrectRejections: rejected.length,
    inspected,
    inspectionSeed: INSPECTION_SEED,
    inspectionRule: "final answer correct and working verdict is incorrect-arithmetic, unparseable-working, or ambiguous; composite key model|condition|itemId; mulberry32 seed 7501; first 20",
  });
}

function main(): void {
  mkdirSync(PHASE, { recursive: true });
  verifyHistory();
  historicalFormat();
  analyzeGenerations();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
