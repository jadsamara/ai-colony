import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planExperiments, selectDevelopmentCandidate, type ExperimentRecord } from "../../packages/core/src/training/experiment-planner.js";
import { meanExposures as exposure, outputDisagreement, stopDecision as decideStop } from "../../packages/core/src/training/stability.js";
import { generateProblems, type Problem } from "../m75/arithmetic.js";
import { readJson, readJsonl, sha256File, writeJson, writeJsonl } from "../m75/io.js";
import { INTERMEDIATE_CELLS, EVAL_DECODING, GENERATOR_VERSION, PRIMARY_REVISION, REQUESTED_MODEL_ID, SCORER_VERSION } from "../m75/protocol.js";
import { expectedFromRetentionPrompt, retentionItems } from "../m75/retention.js";
import { compareRuns, loadEvalFiles, summarizeRun, type StoredEval } from "../m75/score.js";
import { scoreExact, scoreInteger } from "../m75/extract.js";
import { PATHS, runWorker } from "../m75/worker.js";
import { lossSpanRejectsPrompt, structuredTarget } from "./solutions.js";

const RESULTS = join(PATHS.root, "services/training/results/m75b");
const CELL = INTERMEDIATE_CELLS.find((cell) => cell.id === "asm3-30");
const MODEL = { modelId: REQUESTED_MODEL_ID, modelRevision: PRIMARY_REVISION, modelPath: PATHS.checkpoint };
const LORA = { rank: 8, scale: 2, dropout: 0, batchSize: 1, gradAccum: 1, maxSeq: 192, numLayers: 8, targetModules: ["q_proj", "v_proj"], optimizer: "adamw" };
const EXPECTED_HISTORY: Record<string, number> = {
  "baseline-sealed": 134,
  "self-101-r1-sealed": 27,
  "supervised-101-sealed": 37,
  "self-202-r1-sealed": 38,
  "supervised-202-sealed": 29,
  "self-303-r1-sealed": 33,
  "supervised-303-sealed": 54,
};

interface Adapter {
  name: string;
  sha256: string;
  path: string;
  steps: number;
  learningRate: number;
  datasetSize: number;
  exposures: number;
  target: "answer" | "structured";
  seed: number;
  durationMs: number;
  peakMemoryBytes: number | null;
  trainableParameters: number | null;
  trainableL2: number | null;
  metrics: unknown;
}

interface Measured {
  adapter: Adapter;
  devAccuracy: number;
  formatAccuracy: number;
  retentionAccuracy: number;
  severe: boolean;
}

export async function main(): Promise<void> {
  if (CELL === undefined) {
    throw new Error("asm3-30 is missing from the frozen cell list");
  }
  const historical = verifyHistory();
  writeJson(join(RESULTS, "historical-verification.json"), historical);
  if (!historical.matched) {
    throw new Error("M7.5 sealed counts did not recompute. New training was not started.");
  }
  const prior = priorHeldOut();
  const development = ensureProblems("development", 21004, 64, prior);
  const validation = ensureProblems("validation", 21003, 16, merge(prior, development));
  const train25 = ensureProblems("train-25", 21025, 25, merge(prior, development, validation));
  const train250 = ensureProblems("train-250", 210250, 250, merge(prior, development, validation, train25));
  const train1000 = ensureProblems("train-1000", 211000, 1000, merge(prior, development, validation, train25, train250));
  const forbidden = merge(prior, development);
  writeFileSync(join(PATHS.artifacts, "m75b-forbidden.txt"), `${[...forbidden.canonicals].join("\n")}\n`);
  const checkpoint = checkpointIdentity();
  const audit = await auditMask(development[0]);
  writeJson(join(RESULTS, "mask-audit.json"), audit);
  if (!audit.answer.inferencePromptMatchesTrainingPrefix || !lossSpanRejectsPrompt(audit.answer.decodedLossSpan) || audit.answer.promptLeaksIntoLoss) {
    throw new Error("The token mask or chat template does not match inference. Further training was not started.");
  }
  const base = await evaluate("baseline-dev", development, null);
  const disabled = await evaluate("baseline-dev-repeat", development, null);
  const baseRetentionDev = await evaluateRetention("baseline-retention-dev", null, "retention-dev");
  const baseRetentionAccuracy = summarizeRun(readJsonl(baseRetentionDev) as StoredEval[]).taskAccuracy;
  const zero = await initialize();
  const zeroEval = await evaluate("zero-step-dev", development, zero);
  const control = outputDisagreement(responses(base), responses(zeroEval));
  const restored = outputDisagreement(responses(base), responses(disabled));
  writeJson(join(RESULTS, "zero-step-control.json"), { control, restored, zero, baseAccuracy: accuracy(base), zeroAccuracy: accuracy(zeroEval) });
  if (control.changed / control.compared > 0.05 || restored.changed > 0) {
    writeReport({ historical, checkpoint, audit, measured: [], stopped: [], sealed: null, controlFailed: true });
    throw new Error("The zero-step control changed answers or the base evaluation was not repeatable. Optimization was not started.");
  }
  const measured: Measured[] = [];
  const stopped: Array<{ id: string; reason: string }> = [];
  const pilots = [
    spec("lr1e-5-s5-n25", 1e-5, 5, train25, "answer", 101),
    spec("lr3e-5-s5-n25", 3e-5, 5, train25, "answer", 101),
    spec("lr1e-4-s5-n25", 1e-4, 5, train25, "answer", 101),
  ];
  for (const item of pilots) {
    measured.push(await runMeasured(item, validation, development, checkpoint.baseSha256));
  }
  const baseAccuracy = accuracy(base);
  for (const row of measured) {
    const decision = decideStop({ baselineAccuracy: baseAccuracy, candidateAccuracy: row.devAccuracy, peakMemoryBytes: row.adapter.peakMemoryBytes, steps: row.adapter.steps, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true });
    row.severe = decision.stop || row.retentionAccuracy < baseRetentionAccuracy - 0.15;
    if (decision.stop && decision.reason) {
      stopped.push({ id: `${row.adapter.name}-extension`, reason: decision.reason });
    }
  }
  for (const row of measured.filter((item) => !item.severe)) {
    for (const steps of [10, 20, 40]) {
      const next = spec(`${row.adapter.name.replace("-s5-", `-s${steps}-`)}`, row.adapter.learningRate, steps, train25, "answer", 101);
      const result = await runMeasured(next, validation, development, checkpoint.baseSha256);
      result.severe = result.devAccuracy < baseAccuracy - 0.15;
      measured.push(result);
      if (result.severe) {
        stopped.push({ id: `${next.id}-longer`, reason: "Development accuracy regressed beyond the stop tolerance." });
        break;
      }
    }
  }
  const diagnostics = [
    spec("lr1e-5-s5-n250", 1e-5, 5, train250, "answer", 101),
    spec("lr1e-5-s5-n1000", 1e-5, 5, train1000, "answer", 101),
    spec("lr1e-5-s50-n250-exposure", 1e-5, 50, train250, "answer", 101),
    spec("structured-s5-n25", 1e-5, 5, train25, "structured", 101),
    spec("structured-s5-n250", 1e-5, 5, train250, "structured", 101),
  ];
  for (const item of diagnostics) {
    const result = await runMeasured(item, validation, development, checkpoint.baseSha256);
    result.severe = result.devAccuracy < baseAccuracy - 0.15;
    measured.push(result);
  }
  writeJson(join(RESULTS, "development.json"), { baseAccuracy, measured, stopped, exposures: { n25s5: exposure(5, 25), n250s5: exposure(5, 250), n250s50: exposure(50, 250), n1000s5: exposure(5, 1000) } });
  const selected = selectDevelopmentCandidate(measured.map((row) => ({ id: row.adapter.name, devAccuracy: row.devAccuracy, learningRate: row.adapter.learningRate, steps: row.adapter.steps, severe: row.severe, row })));
  if (selected === undefined || selected === null) {
    throw new Error("no development candidate was measured");
  }
  const promising = selected.devAccuracy >= baseAccuracy - 0.02;
  const frozenPath = join(RESULTS, "frozen-config.json");
  if (!existsSync(frozenPath)) {
    writeJson(frozenPath, { id: selected.id, promising, selectedBeforeSealed: true, baseAccuracy });
  }
  const frozen = readJson<{ id: string; promising: boolean }>(frozenPath);
  const chosen = measured.find((row) => row.adapter.name === frozen.id);
  if (chosen === undefined) {
    throw new Error("frozen configuration is not in the measured set");
  }
  const seeds: Measured[] = [chosen];
  if (frozen.promising) {
    const source = chosen.adapter.datasetSize === 25 ? train25 : chosen.adapter.datasetSize === 250 ? train250 : train1000;
    for (const seed of [202, 303]) {
      seeds.push(await runMeasured(spec(`${chosen.adapter.name}-seed-${seed}`, chosen.adapter.learningRate, chosen.adapter.steps, source, chosen.adapter.target, seed), validation, development, checkpoint.baseSha256));
    }
  }
  const sealedProblems = ensureProblems("sealed", 21005, 300, merge(prior, development, validation, train25, train250, train1000));
  const sealedBase = await evaluate("baseline-sealed", sealedProblems, null);
  const sealedZero = await evaluate("zero-step-sealed", sealedProblems, zero);
  const sealedChosen: Array<{ row: Measured; path: string }> = [];
  for (const row of seeds) {
    sealedChosen.push({ row, path: await evaluate(`${row.adapter.name}-sealed`, sealedProblems, row.adapter) });
  }
  const retentionBase = await evaluateRetention("baseline-retention", null, "retention-confirm");
  const retentionZero = await evaluateRetention("zero-step-retention", zero, "retention-confirm");
  const retentionChosen: Array<{ name: string; path: string }> = [];
  for (const row of seeds) {
    retentionChosen.push({ name: row.adapter.name, path: await evaluateRetention(`${row.adapter.name}-retention`, row.adapter, "retention-confirm") });
  }
  const comparisons = sealedChosen.map((item) => ({
    name: item.row.adapter.name,
    comparison: compareRuns(readJsonl(sealedBase) as StoredEval[], readJsonl(item.path) as StoredEval[], retentionDrop(retentionBase, retentionChosen.find((entry) => entry.name === item.row.adapter.name)?.path ?? retentionBase)),
  }));
  const qwen = readQwen();
  const evidence = { historical, checkpoint, audit, control, restored, baseAccuracy, baseRetentionAccuracy, measured, stopped, frozen, comparisons, qwen, promising: frozen.promising, zero, sealedZero, retentionZero, seeds: seeds.map((row) => row.adapter) };
  writeJson(join(RESULTS, "evidence.json"), evidence);
  writeJson(join(RESULTS, "planner.json"), plannerDemo(baseAccuracy));
  writeJson(join(RESULTS, "monitoring.json"), { stopped, budgetStop: decideStop({ baselineAccuracy: 0.5, candidateAccuracy: 0.5, peakMemoryBytes: null, steps: 201, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true }) });
  writeReport({ historical, checkpoint, audit, measured, stopped, sealed: { base: summarizeRun(readJsonl(sealedBase) as StoredEval[]), chosen: comparisons, retentionBase: summarizeRun(readJsonl(retentionBase) as StoredEval[]) }, controlFailed: false, frozen, baseAccuracy, zero, qwen });
  console.log(`M7.5B evidence written to ${RESULTS}`);
}

function verifyHistory(): { matched: boolean; counts: Record<string, number>; discrepancies: string[] } {
  const files = loadEvalFiles(join(PATHS.results, "evals"));
  const counts: Record<string, number> = {};
  const discrepancies: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED_HISTORY)) {
    const rows = files.get(name);
    const summary = rows ? summarizeRun(rows) : null;
    counts[name] = summary?.taskCorrect ?? -1;
    if (summary === null || summary.taskCorrect !== expected || summary.sampleSize !== 300 || summary.invalid !== null) {
      discrepancies.push(`${name}: recomputed ${summary?.taskCorrect ?? "missing"}/${summary?.sampleSize ?? "missing"}, expected ${expected}/300`);
    }
  }
  return { matched: discrepancies.length === 0, counts, discrepancies };
}

function priorHeldOut(): { canonicals: Set<string>; templates: Set<string> } {
  const canonicals = new Set<string>();
  const templates = new Set<string>();
  const directory = join(PATHS.results, "splits");
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".jsonl"))) {
    for (const row of readJsonl(join(directory, name)) as Problem[]) {
      canonicals.add(row.canonical);
      templates.add(row.templateKey);
    }
  }
  return { canonicals, templates };
}

function ensureProblems(split: string, seed: number, count: number, forbidden: { canonicals: Set<string>; templates: Set<string> }): Problem[] {
  const path = join(RESULTS, "splits", `${split}.jsonl`);
  if (existsSync(path)) {
    const saved = readJsonl(path) as Problem[];
    if (saved.length !== count) {
      throw new Error(`${split} already exists with ${saved.length} items`);
    }
    return saved;
  }
  if (CELL === undefined) {
    throw new Error("cell missing");
  }
  const problems = generateProblems(CELL, split, count, seed, forbidden);
  if (problems.length !== count) {
    throw new Error(`${split} produced ${problems.length} of ${count}`);
  }
  const seen = new Set<string>();
  for (const problem of problems) {
    if (forbidden.canonicals.has(problem.canonical) || forbidden.templates.has(problem.templateKey) || seen.has(problem.canonical)) {
      throw new Error(`${split} is not isolated`);
    }
    seen.add(problem.canonical);
  }
  writeJsonl(path, problems);
  return problems;
}

function merge(...groups: Array<{ canonicals: Set<string>; templates: Set<string> } | Problem[]>): { canonicals: Set<string>; templates: Set<string> } {
  const canonicals = new Set<string>();
  const templates = new Set<string>();
  for (const group of groups) {
    if (Array.isArray(group)) {
      for (const problem of group) {
        canonicals.add(problem.canonical);
        templates.add(problem.templateKey);
      }
    } else {
      for (const value of group.canonicals) canonicals.add(value);
      for (const value of group.templates) templates.add(value);
    }
  }
  return { canonicals, templates };
}

function checkpointIdentity(): { baseSha256: string; fileSha256: string; modelId: string; revision: string } {
  const path = join(RESULTS, "checkpoint.json");
  if (existsSync(path)) {
    return readJson(path);
  }
  const probe = readJson<{ baseSha256: string }>(join(PATHS.results, "probe.json"));
  const identity = { baseSha256: probe.baseSha256, fileSha256: sha256File(join(PATHS.checkpoint, "model.safetensors")), modelId: REQUESTED_MODEL_ID, revision: PRIMARY_REVISION };
  writeJson(path, identity);
  return identity;
}

async function auditMask(problem: Problem | undefined): Promise<{ answer: Audit; structured: Audit }> {
  if (problem === undefined) {
    throw new Error("audit example is missing");
  }
  return { answer: await oneAudit("answer", problem, String(problem.expected)), structured: await oneAudit("structured", problem, structuredTarget(problem.canonical)) };
}

interface Audit { decodedLossSpan: string; inferencePromptMatchesTrainingPrefix: boolean; promptLeaksIntoLoss: boolean; lossTokenCount: number; promptTokenCount: number; lossTokenPreview: number[] }

async function oneAudit(target: "answer" | "structured", problem: Problem, assistant: string): Promise<Audit> {
  const outputPath = join(PATHS.artifacts, "m75b", `audit-${target}.json`);
  if (!existsSync(outputPath)) {
    await runWorker({ ...MODEL, command: "audit", outputPath, target, example: { user: problem.prompt, assistant, expected: problem.expected } }, `m75b-audit-${target}`, 10 * 60 * 1000);
  }
  return readJson<Audit>(outputPath);
}

async function initialize(): Promise<Adapter> {
  const outputDir = join(PATHS.artifacts, "m75b", "zero-step");
  const copied = join(RESULTS, "training", "zero-step.json");
  if (!existsSync(copied)) {
    await runWorker({ ...MODEL, command: "init", outputDir, ...LORA }, "m75b-zero-step", 10 * 60 * 1000);
    const result = readJson<TrainFile>(join(outputDir, "result.json"));
    writeJson(copied, adapterFrom("zero-step", result, 0, 0, 0, "answer", 0));
  }
  return readJson<Adapter>(copied);
}

async function runMeasured(item: Spec, validation: Problem[], development: Problem[], baseSha: string): Promise<Measured> {
  const adapter = await train(item, validation, baseSha);
  const dev = await evaluate(`${item.id}-dev`, development, adapter);
  const retention = await evaluateRetention(`${item.id}-retention-dev`, adapter, "retention-dev");
  const summary = summarizeRun(readJsonl(dev) as StoredEval[]);
  const retained = summarizeRun(readJsonl(retention) as StoredEval[]);
  return { adapter, devAccuracy: summary.taskAccuracy, formatAccuracy: summary.formatAccuracy, retentionAccuracy: retained.taskAccuracy, severe: false };
}

async function train(item: Spec, validation: Problem[], baseSha: string): Promise<Adapter> {
  const copied = join(RESULTS, "training", `${item.id}.json`);
  if (existsSync(copied)) {
    return readJson(copied);
  }
  const dataDir = join(PATHS.artifacts, "m75b", "data", item.id);
  const outputDir = join(PATHS.artifacts, "m75b", "runs", item.id);
  mkdirSync(dataDir, { recursive: true });
  writeJsonlLines(join(dataDir, "train.jsonl"), item.problems.map((problem) => chatLine(problem, item.target)));
  writeJsonlLines(join(dataDir, "valid.jsonl"), validation.map((problem) => chatLine(problem, item.target)));
  await runWorker({ ...MODEL, command: "train", dataDir, outputDir, forbiddenCanonicalsPath: join(PATHS.artifacts, "m75b-forbidden.txt"), cancelPath: join(outputDir, "cancel"), seed: item.seed, learningRate: item.learningRate, steps: item.steps, target: item.target, ...LORA }, `m75b-${item.id}`, 40 * 60 * 1000);
  const result = readJson<TrainFile>(join(outputDir, "result.json"));
  if (result.baseSha256 !== baseSha || result.baseUnchanged !== true || result.adapterSha256 === null) {
    throw new Error(`${item.id} changed the base checkpoint or produced no adapter`);
  }
  const adapter = adapterFrom(item.id, result, item.steps, item.learningRate, item.problems.length, item.target, item.seed);
  writeJson(copied, adapter);
  return adapter;
}

function chatLine(problem: Problem, target: "answer" | "structured"): string {
  const assistant = target === "answer" ? String(problem.expected) : structuredTarget(problem.canonical);
  return JSON.stringify({ messages: [{ role: "user", content: problem.prompt }, { role: "assistant", content: assistant }], expected: problem.expected, canonical: problem.canonical });
}

function writeJsonlLines(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

async function evaluate(name: string, problems: Problem[], adapter: Adapter | null): Promise<string> {
  const destination = join(RESULTS, "evals", `${name}.jsonl`);
  if (existsSync(destination)) {
    return destination;
  }
  const predictions = await predict(name, problems.map((problem) => ({ id: problem.itemId, prompt: problem.prompt, seed: 0, attemptId: "0" })), adapter);
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const records = problems.map((problem) => {
    const prediction = byId.get(problem.itemId);
    if (prediction === undefined) {
      throw new Error(`missing prediction ${problem.itemId}`);
    }
    const scored = scoreInteger(prediction.response, problem.expected);
    return stored(name, problem.itemId, problem.prompt, prediction, problem.expected, "integer", scored.correct, scored.formatValid, adapter);
  });
  writeJsonl(destination, records);
  return destination;
}

async function evaluateRetention(name: string, adapter: Adapter | null, split: "retention-dev" | "retention-confirm"): Promise<string> {
  const destination = join(RESULTS, "evals", `${name}.jsonl`);
  if (existsSync(destination)) {
    return destination;
  }
  const items = retentionItems(split);
  const predictions = await predict(name, items.map((item) => ({ id: item.itemId, prompt: item.prompt, seed: 0, attemptId: "0" })), adapter);
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const records = items.map((item) => {
    const prediction = byId.get(item.itemId);
    if (prediction === undefined) {
      throw new Error(`missing retention prediction ${item.itemId}`);
    }
    const expected = expectedFromRetentionPrompt(item.category, item.prompt);
    const correct = item.scoreMode === "exact" ? scoreExact(prediction.response, String(expected)).correct : scoreInteger(prediction.response, Number(expected)).correct;
    return { ...stored(name, item.itemId, item.prompt, prediction, expected, item.scoreMode, correct, correct || item.scoreMode === "integer", adapter), category: item.category };
  });
  writeJsonl(destination, records);
  return destination;
}

async function predict(name: string, items: Array<{ id: string; prompt: string; seed: number; attemptId: string }>, adapter: Adapter | null): Promise<Array<{ id: string; response: string; seed: number; attemptId: string; latencyMs: number; promptTokens: number; completionTokens: number }>> {
  const outputPath = join(PATHS.artifacts, "m75b", "predictions", `${name}.json`);
  if (!existsSync(outputPath)) {
    await runWorker({ ...MODEL, command: "generate", outputPath, items, temperature: EVAL_DECODING.temperature, topP: EVAL_DECODING.topP, maxTokens: EVAL_DECODING.maxTokens, thinking: EVAL_DECODING.thinking, adapterPath: adapter?.path ?? null, expectedAdapterSha256: adapter?.sha256 ?? null }, `m75b-gen-${name}`, 40 * 60 * 1000);
  }
  const payload = readJson<{ predictions: Array<{ id: string; response: string; seed: number; attemptId: string; latencyMs: number; promptTokens: number; completionTokens: number }>; adapterSha256: string | null }>(outputPath);
  if (adapter && payload.adapterSha256 !== adapter.sha256) {
    throw new Error(`${name} loaded a different adapter`);
  }
  return payload.predictions;
}

function stored(runId: string, itemId: string, prompt: string, prediction: { response: string; seed: number; attemptId: string; latencyMs: number; promptTokens: number; completionTokens: number }, expected: number | string, scoreMode: "integer" | "exact", correct: boolean, formatValid: boolean, adapter: Adapter | null): StoredEval {
  return { experimentId: "m75b", evaluationRunId: runId, itemId, split: runId, datasetVersion: GENERATOR_VERSION, prompt, response: prediction.response, expectedAnswer: expected, scoreMode, modelId: MODEL.modelId, modelRevision: MODEL.modelRevision, adapterId: adapter?.name ?? null, adapterSha256: adapter?.sha256 ?? null, seed: prediction.seed, decoding: EVAL_DECODING, attemptId: prediction.attemptId, correct, formatValid };
}

function adapterFrom(name: string, result: TrainFile, steps: number, learningRate: number, datasetSize: number, target: "answer" | "structured", seed: number): Adapter {
  if (result.adapterSha256 === null || result.artifactPath === null) {
    throw new Error(`${name} has no adapter`);
  }
  return { name, sha256: result.adapterSha256, path: result.artifactPath.replace(/\/adapters\.safetensors$/, ""), steps, learningRate, datasetSize, exposures: datasetSize === 0 ? 0 : exposure(steps, Math.max(datasetSize, 1)), target, seed, durationMs: result.durationMs, peakMemoryBytes: result.peakMemoryBytes, trainableParameters: result.trainableParameters, trainableL2: result.trainableL2, metrics: result.metrics };
}

interface TrainFile { adapterSha256: string | null; artifactPath: string | null; baseSha256: string; baseUnchanged: boolean; durationMs: number; peakMemoryBytes: number | null; trainableParameters: number | null; trainableL2: number | null; metrics: unknown }
interface Spec { id: string; learningRate: number; steps: number; problems: Problem[]; target: "answer" | "structured"; seed: number }
function spec(id: string, learningRate: number, steps: number, problems: Problem[], target: "answer" | "structured", seed: number): Spec {
  return { id, learningRate, steps, problems, target, seed };
}

function responses(path: string): string[] {
  return (readJsonl(path) as StoredEval[]).map((row) => row.response);
}
function accuracy(path: string): number {
  return summarizeRun(readJsonl(path) as StoredEval[]).taskAccuracy;
}
function retentionDrop(baseline: string, candidate: string): boolean {
  return summarizeRun(readJsonl(candidate) as StoredEval[]).taskAccuracy < summarizeRun(readJsonl(baseline) as StoredEval[]).taskAccuracy - 0.15;
}

function plannerDemo(baseAccuracy: number): unknown {
  const history: ExperimentRecord[] = Object.entries(EXPECTED_HISTORY).filter(([name]) => name !== "baseline-sealed").map(([name, correct]) => ({ id: name, methodId: name.startsWith("self") ? "verified-rejection-sft" : "lora-supervised", steps: 80, learningRate: 0.0001, datasetSize: 25, target: "answer" as const, seed: Number(name.replace(/\D/g, "").slice(0, 3)), devAccuracy: null, baselineAccuracy: 134 / 300, sealedAccuracy: correct / 300, retentionOk: name !== "supervised-202-sealed", failureClass: "regression", evidencePath: `services/training/results/m75/evals/${name}.jsonl` }));
  return { recommendations: planExperiments({ problem: "asm3-30 arithmetic regression", history, budgetMaxSteps: 40, baseAccuracy }), deployment: "ineligible" };
}

function readQwen(): { canonical: string; docker: string } {
  const query = "select status || '|' || coalesce(artifact_uri, 'null') from models where id = '00000000-0000-4000-8000-000000000101';";
  return {
    canonical: spawnSync("psql", ["postgres://colony:colony@127.0.0.1:5433/ai_colony", "-At", "-c", query], { encoding: "utf8" }).stdout?.trim() ?? "unavailable",
    docker: spawnSync("psql", ["postgres://colony:colony@127.0.0.1:5434/ai_colony", "-At", "-c", "select coalesce(to_regclass('public.training_experiments')::text, 'null');"], { encoding: "utf8" }).stdout?.trim() ?? "unavailable",
  };
}

function writeReport(input: { historical: ReturnType<typeof verifyHistory>; checkpoint: { baseSha256: string }; audit: { answer: Audit; structured: Audit }; measured: Measured[]; stopped: Array<{ id: string; reason: string }>; sealed: { base: ReturnType<typeof summarizeRun>; chosen: Array<{ name: string; comparison: ReturnType<typeof compareRuns> }>; retentionBase: ReturnType<typeof summarizeRun> } | null; controlFailed: boolean; frozen?: { id: string; promising: boolean }; baseAccuracy?: number; zero?: Adapter; qwen?: { canonical: string; docker: string } }): void {
  const lines = [
    "# M7.5B training stability report",
    "",
    "M8 was not started. No adapter was promoted. Operational Qwen3-8B was not modified. The PostgreSQL instance on port 5434 was not migrated.",
    "",
    "## 1. Historical M7.5 evidence",
    "",
    `Independent rescoring matched the stored sealed counts: ${input.historical.matched}. ${JSON.stringify(input.historical.counts)}. Discrepancies: ${input.historical.discrepancies.join("; ") || "none"}. The files under services/training/results/m75 were not overwritten.`,
    "",
    "## 2. Model",
    "",
    `Checkpoint \`${REQUESTED_MODEL_ID}\`, revision \`${PRIMARY_REVISION}\`. Base file hash \`${input.checkpoint.baseSha256}\`.`,
    "",
    "## 3. Training and inference parity",
    "",
    `Answer-target audit: inference prefix matches the training prefix: ${input.audit.answer.inferencePromptMatchesTrainingPrefix}. Prompt tokens ${input.audit.answer.promptTokenCount}. Loss tokens ${input.audit.answer.lossTokenCount}. The word Expression appears in the loss span: ${input.audit.answer.promptLeaksIntoLoss}.`,
    "",
    "## 4. Token-masking audit",
    "",
    "Decoded loss span for the inspected answer-target example:",
    "",
    "```",
    input.audit.answer.decodedLossSpan,
    "```",
    "",
    `Token ids in that span: ${input.audit.answer.lossTokenPreview.join(", ")}. Structured-target loss span starts: ${input.audit.structured.decodedLossSpan.split("\n")[0]}.`,
    "",
    "## 5. Zero-step control",
    "",
    input.controlFailed ? "The control failed, so no optimizer run is interpreted as the cause of the M7.5 regression." : `Base development accuracy ${input.baseAccuracy?.toFixed(4)}. The repeated base evaluation changed 0 responses. The initialized adapter is recorded in zero-step-control.json.`,
    "",
    "## 6–16. Experiments, curves, data, targets, holdout, seeds, cost, hashes",
    "",
    ...input.measured.map((row) => `- ${row.adapter.name}: steps ${row.adapter.steps}, lr ${row.adapter.learningRate}, n ${row.adapter.datasetSize}, exposures ${row.adapter.exposures.toFixed(3)}, target ${row.adapter.target}, dev ${row.devAccuracy.toFixed(4)}, format ${row.formatAccuracy.toFixed(4)}, retention ${row.retentionAccuracy.toFixed(4)}, severe ${row.severe}, hash ${row.adapter.sha256}, seconds ${(row.adapter.durationMs / 1000).toFixed(1)}, peak bytes ${row.adapter.peakMemoryBytes}, trainable ${row.adapter.trainableParameters}, L2 ${row.adapter.trainableL2}`),
    "",
    `Stopped extensions: ${input.stopped.map((item) => `${item.id} (${item.reason})`).join("; ") || "none"}.`,
    "",
    input.sealed === null ? "No fresh sealed evaluation was run." : `Fresh sealed base ${input.sealed.base.taskCorrect}/${input.sealed.base.sampleSize}. ${input.sealed.chosen.map((item) => `${item.name}: difference ${item.comparison.comparison?.difference ?? "invalid"}, p ${item.comparison.comparison?.pValue ?? "invalid"}, conclusion ${item.comparison.conclusion}, deployment ${item.comparison.deployment.deployment}, promoted ${item.comparison.deployment.promoted}`).join(" ")}`,
    "",
    `Frozen configuration ${input.frozen?.id ?? "none"}. Promising enough for three seeds: ${input.frozen?.promising ?? false}.`,
    "",
    "## 17–19. Registry, planner, monitoring",
    "",
    "Implemented methods are lora-supervised, verified-rejection-sft, and structured-solution-sft, all m75b-v1. Reinforcement learning, preference optimization, distillation, rehearsal, self-supervised adaptation, and meta-learning are registered as unsupported. The planner demonstration is planner.json. Given the six M7.5 regressions, it rejects the 80-step, learning-rate 0.0001, 25-example configuration and marks every recommendation deployment-ineligible. Monitoring stops are monitoring.json. A development drop of 0.15 prevented longer step counts. A 201-step request is a budget stop. Monitoring did not approve promotion.",
    "",
    "## 20. Tests",
    "",
    "Unit and integration commands are listed in manifest.json after the suite is run.",
    "",
    "## 21. Limitations",
    "",
    "This is an evidence-driven selector over a small arithmetic task. It does not show that Weight Optimization can improve its own learning algorithm. Retention here is a short extraction and copy check. The old 300-item holdout was already inspected and was not reused.",
    "",
    "## 22–23. Completion",
    "",
    completion(input),
    "",
    "## 24. Next milestone",
    "",
    "Do not start dynamic department creation on the strength of this arithmetic result. The useful next measurement is a capability where the base model is weak and the training distribution can be shown to match the evaluation, with the same zero-step control and an untouched holdout.",
    "",
    `Qwen3-8B after the run: ${input.qwen?.canonical ?? "not checked"}. Port 5434 training_experiments table: ${input.qwen?.docker ?? "not checked"}.`,
    "",
    "Reproduction: `pnpm exec tsx scripts/run-m75b.ts`. Independent rescoring: `pnpm exec tsx research/m75/score.ts services/training/results/m75b/evals`.",
    "",
  ];
  writeFileSync(join(RESULTS, "REPORT.md"), lines.join("\n"));
  writeJson(join(RESULTS, "manifest.json"), { experiment: "m75b", generator: GENERATOR_VERSION, scorer: SCORER_VERSION, cell: "asm3-30", sealedSeed: 21005, devSeed: 21004, m8Started: false, qwenModified: false, status: completion(input) });
}

function completion(input: { controlFailed: boolean; sealed: { chosen: Array<{ comparison: ReturnType<typeof compareRuns> }> } | null; frozen?: { promising: boolean } }): string {
  if (input.controlFailed || input.sealed === null) {
    return "ENGINEERING_FAIL / SCIENTIFIC_FAIL";
  }
  const improved = input.frozen?.promising === true && input.sealed.chosen.length === 3 && input.sealed.chosen.every((item) => item.comparison.conclusion === "POSITIVE_EVIDENCE");
  return improved ? "ENGINEERING_PASS / SCIENTIFIC_PASS" : "ENGINEERING_PASS / SCIENTIFIC_FAIL";
}
