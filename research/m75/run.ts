import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { decideGate, GATE_POLICY, gatePolicyHash } from "../../packages/core/src/evaluation/gate.js";
import { IMPROVEMENT_POLICY, improvementPolicyHash, verifyImprovement } from "../../packages/core/src/evaluation/improvement.js";
import { allocationFor, continueSelfTraining, extensionDirection, findCell, phase1Decision, retentionFailed, selectCalibrationCell } from "./analysis.js";
import { assertDisjoint, generateProblems, oodCell, type Problem } from "./arithmetic.js";
import { assertNoCanonicalLeak, matchSupervised, programmaticExamples, toChatLine, verifiedExamples, type TrainingExample } from "./datasets.js";
import { scoreExact, scoreInteger } from "./extract.js";
import { readJson, readJsonl, sha256File, writeJson, writeJsonl } from "./io.js";
import { CALIBRATION_CELLS, EASIER_CELLS, EVAL_DECODING, EXPERIMENT_ID, FALLBACK_MODEL_ID, GENERATOR_VERSION, HARDER_CELLS, INTERMEDIATE_CELLS, PRIMARY_REVISION, REQUESTED_MODEL_ID, SAMPLE_DECODING, SCORER_VERSION, SPLIT_SEEDS, TRAIN_CONFIG, TRAINING_SEEDS, type TaskCell } from "./protocol.js";
import { expectedFromRetentionPrompt, retentionItems, type RetentionItem } from "./retention.js";
import { compareRuns, summarizeRun, type StoredEval } from "./score.js";
import { PATHS, runPython, runWorker } from "./worker.js";

interface PredictionFile {
  predictions: Array<{ id: string; attemptId: string; response: string; seed: number; latencyMs: number; promptTokens: number; completionTokens: number }>;
  loadedAdapter: boolean;
  adapterSha256: string | null;
  baseSha256: string;
  peakMemoryBytes: number | null;
  durationMs: number;
}

interface TrainResult {
  cancelled: boolean;
  artifactPath: string | null;
  adapterSha256: string | null;
  durationMs: number;
  peakMemoryBytes: number | null;
  metrics: unknown[];
  trainableParameters: number;
  baseSha256: string;
  baseUnchanged: boolean;
  exampleCount: number;
  maskedTarget: string;
}

interface AdapterInfo {
  name: string;
  seed: number;
  condition: "supervised" | "self";
  round: number;
  confirmatory: boolean;
  sha256: string;
  path: string;
  examples: number;
  steps: number;
  durationMs: number;
  peakMemoryBytes: number | null;
  matched: boolean;
  easyDominated: boolean;
}

const MODEL = {
  modelId: REQUESTED_MODEL_ID,
  modelRevision: PRIMARY_REVISION,
  modelPath: PATHS.checkpoint,
};

export async function main(): Promise<void> {
  mkdirSync(PATHS.results, { recursive: true });
  const startedAt = new Date().toISOString();
  const context = {
    startedAt,
    hardware: hardware(),
    qwenBefore: command("psql", ["postgres://colony:colony@127.0.0.1:5433/ai_colony", "-At", "-c", "select status || '|' || coalesce(artifact_uri, 'null') from models where id = '00000000-0000-4000-8000-000000000101';"]),
    dockerBefore: command("psql", ["postgres://colony:colony@127.0.0.1:5434/ai_colony", "-At", "-c", "select coalesce(to_regclass('public.improvement_decisions')::text, 'null');"]),
    ollama: unloadOllama(),
    policies: { gate: GATE_POLICY, gateHash: gatePolicyHash(), improvement: IMPROVEMENT_POLICY, improvementHash: improvementPolicyHash() },
  };
  writeJson(join(PATHS.results, "context.json"), context);
  decide("start", context);
  await ensureWeights(MODEL.modelPath, MODEL.modelId, MODEL.modelRevision);
  const probe = await ensureProbe();
  const frozen = await ensureFrozen();
  const splits = await ensureSplits(frozen.cell, frozen.allocation);
  const baselineDev = await evaluateProblems("baseline-dev", splits.development, null);
  const baselineRetentionDev = await evaluateRetention("baseline-retention-dev", retentionItems("retention-dev"), null);
  const seeds = [];
  for (const seed of TRAINING_SEEDS) {
    seeds.push(await runSeed(seed, splits, probe.baseSha256));
  }
  const exploratory = await exploratoryRounds(seeds, baselineRetentionDev, probe.baseSha256);
  const confirmatory = seeds.flatMap((seed) => [seed.self, seed.supervised].filter((item): item is AdapterInfo => item !== undefined && item.confirmatory));
  const sealed = await evaluateProblems("baseline-sealed", splits.sealed, null);
  const ood = await evaluateProblems("baseline-ood", splits.ood, null);
  const retention = await evaluateRetention("baseline-retention", retentionItems("retention-confirm"), null);
  const candidateEvals = [];
  for (const adapter of confirmatory) {
    candidateEvals.push({
      adapter,
      sealed: await evaluateProblems(`${adapter.name}-sealed`, splits.sealed, adapter),
      ood: await evaluateProblems(`${adapter.name}-ood`, splits.ood, adapter),
      retention: await evaluateRetention(`${adapter.name}-retention`, retentionItems("retention-confirm"), adapter),
    });
  }
  const report = renderReport({
    context,
    probe,
    frozen,
    splits,
    baselineDev,
    sealed,
    ood,
    retention,
    seeds,
    exploratory,
    candidateEvals,
  });
  const finished = {
    ...context,
    qwenAfter: command("psql", ["postgres://colony:colony@127.0.0.1:5433/ai_colony", "-At", "-c", "select status || '|' || coalesce(artifact_uri, 'null') from models where id = '00000000-0000-4000-8000-000000000101';"]),
    dockerAfter: command("psql", ["postgres://colony:colony@127.0.0.1:5434/ai_colony", "-At", "-c", "select coalesce(to_regclass('public.improvement_decisions')::text, 'null');"]),
    finishedAt: new Date().toISOString(),
    phase2: "not started",
  };
  const scientific = report.includes("Scientific completion: PASS.") ? "PASS" : "FAIL";
  writeJson(join(PATHS.results, "manifest.json"), { ...finished, engineering: "PASS", scientific, phase: "phase-1-complete", report: "REPORT.md", fileHashes: hashResults() });
  await import("node:fs").then((fs) => fs.writeFileSync(join(PATHS.results, "REPORT.md"), report));
  if (finished.qwenBefore !== finished.qwenAfter) {
    throw new Error("operational Qwen3-8B changed during the standalone experiment");
  }
  if (finished.dockerBefore !== finished.dockerAfter) {
    throw new Error("Docker PostgreSQL on port 5434 changed during the standalone experiment");
  }
}

async function ensureWeights(directory: string, repo: string, revision: string): Promise<void> {
  if (existsSync(join(directory, "model.safetensors"))) {
    return;
  }
  const revisionArg = revision.length > 0 ? `, revision=${JSON.stringify(revision)}` : "";
  await runPython(["-c", `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(repo)}${revisionArg}, local_dir=${JSON.stringify(directory)})`], 30 * 60 * 1000);
}

async function ensureProbe(): Promise<{ baseSha256: string; peakMemoryBytes: number | null; layers: number; quantization: unknown; maskedTarget: string; durationMs: number }> {
  const destination = join(PATHS.results, "probe.json");
  if (existsSync(destination)) {
    return readJson(destination);
  }
  const outputDir = join(PATHS.artifacts, "probe");
  await runWorker(
    {
      ...MODEL,
      command: "probe",
      outputDir,
      ...TRAIN_CONFIG,
      probeExamples: [{ user: "Compute the value of the expression. Reply with the integer result only.\nExpression: 1000003 + 5", assistant: "1000008" }],
    },
    "probe",
    20 * 60 * 1000,
  );
  const probe = readJson<Record<string, unknown>>(join(outputDir, "probe.json"));
  writeJson(destination, probe);
  decide("probe", { baseSha256: probe.baseSha256, layers: probe.layers, quantization: probe.quantization, maskedTarget: probe.maskedTarget });
  return probe as { baseSha256: string; peakMemoryBytes: number | null; layers: number; quantization: unknown; maskedTarget: string; durationMs: number };
}

async function ensureFrozen(): Promise<{ cell: TaskCell; allocation: ReturnType<typeof allocationFor>; selection: ReturnType<typeof selectCalibrationCell> }> {
  const destination = join(PATHS.results, "frozen-task.json");
  if (existsSync(destination)) {
    return readJson(destination);
  }
  const cells = [...CALIBRATION_CELLS];
  let measurements = await calibrateCells(cells, 7100);
  const direction = extensionDirection(measurements);
  if (direction !== null) {
    const extra = direction === "harder" ? HARDER_CELLS : EASIER_CELLS;
    cells.push(...extra);
    measurements = measurements.concat(await calibrateCells(extra, 8100));
    decide("calibration-extension", { direction });
  }
  let selection = selectCalibrationCell(measurements, cells);
  if (selection.bandMissed) {
    const pending = INTERMEDIATE_CELLS.filter((cell) => !measurements.some((item) => item.id === cell.id));
    if (pending.length > 0) {
      cells.push(...pending);
      measurements = measurements.concat(await calibrateCells(pending, 9100));
      selection = selectCalibrationCell(measurements, cells);
      decide("calibration-intermediate", { selection });
    }
  }
  const cell = findCell(cells, selection.id);
  const allocation = allocationFor(cell);
  const frozen = { cell, allocation, selection, measurements, decoding: EVAL_DECODING, sampleDecoding: SAMPLE_DECODING, train: TRAIN_CONFIG, sealedEvaluated: false };
  writeJson(destination, frozen);
  decide("freeze-task", { cell: cell.id, selection, allocation });
  return { cell, allocation, selection };
}

async function calibrateCells(cells: TaskCell[], seedBase: number): Promise<Array<{ id: string; accuracy: number; sampleSize: number }>> {
  const measurements = [];
  for (const [index, cell] of cells.entries()) {
    const name = `calibration-${cell.id}`;
    const problems = loadOrCreate(name, () => generateProblems(cell, name, 16, seedBase + index));
    const evalPath = join(PATHS.results, "evals", `${name}.jsonl`);
    if (!existsSync(evalPath)) {
      await evaluateProblems(name, problems, null);
    }
    const records = readJsonl(evalPath) as StoredEval[];
    const summary = summarizeRun(records);
    measurements.push({ id: cell.id, accuracy: summary.taskAccuracy, sampleSize: summary.sampleSize });
  }
  return measurements;
}

function loadOrCreate(name: string, create: () => Problem[]): Problem[] {
  const path = join(PATHS.results, "splits", `${name}.jsonl`);
  if (existsSync(path)) {
    return readJsonl(path) as Problem[];
  }
  const problems = create();
  writeJsonl(path, problems);
  return problems;
}

async function ensureSplits(cell: TaskCell, allocation: ReturnType<typeof allocationFor>): Promise<{ development: Problem[]; validation: Problem[]; sealed: Problem[]; ood: Problem[]; experience: Problem[]; supervisedPool: Problem[] }> {
  const marker = join(PATHS.results, "splits", "ready.json");
  if (existsSync(marker)) {
    return {
      development: readJsonl(join(PATHS.results, "splits", "development.jsonl")) as Problem[],
      validation: readJsonl(join(PATHS.results, "splits", "validation.jsonl")) as Problem[],
      sealed: readJsonl(join(PATHS.results, "splits", "sealed.jsonl")) as Problem[],
      ood: readJsonl(join(PATHS.results, "splits", "ood.jsonl")) as Problem[],
      experience: readJsonl(join(PATHS.results, "splits", "experience.jsonl")) as Problem[],
      supervisedPool: readJsonl(join(PATHS.results, "splits", "supervised-pool.jsonl")) as Problem[],
    };
  }
  const forbidden = { canonicals: new Set<string>(), templates: new Set<string>() };
  for (const name of readdirSync(join(PATHS.results, "splits")).filter((entry) => entry.startsWith("calibration-"))) {
    absorb(forbidden, readJsonl(join(PATHS.results, "splits", name)) as Problem[]);
  }
  const development = generateProblems(cell, "development", allocation.devEval, SPLIT_SEEDS.development, forbidden);
  absorb(forbidden, development);
  const validation = generateProblems(cell, "validation", allocation.validation, SPLIT_SEEDS.validation, forbidden);
  absorb(forbidden, validation);
  const experience = generateProblems(cell, "experience", allocation.experience, SPLIT_SEEDS.experience, forbidden);
  absorb(forbidden, experience);
  const supervisedPool = generateProblems(cell, "supervised-pool", allocation.supervisedPool, SPLIT_SEEDS.supervised, forbidden);
  absorb(forbidden, supervisedPool);
  const sealed = generateProblems(cell, "sealed", allocation.sealed, SPLIT_SEEDS.sealed, forbidden);
  absorb(forbidden, sealed);
  const ood = generateProblems(oodCell(cell), "ood", allocation.ood, SPLIT_SEEDS.ood, forbidden);
  assertDisjoint([development, validation, experience, supervisedPool, sealed, ood]);
  writeJsonl(join(PATHS.results, "splits", "development.jsonl"), development);
  writeJsonl(join(PATHS.results, "splits", "validation.jsonl"), validation);
  writeJsonl(join(PATHS.results, "splits", "experience.jsonl"), experience);
  writeJsonl(join(PATHS.results, "splits", "supervised-pool.jsonl"), supervisedPool);
  writeJsonl(join(PATHS.results, "splits", "sealed.jsonl"), sealed);
  writeJsonl(join(PATHS.results, "splits", "ood.jsonl"), ood);
  writeJson(marker, { hashes: { development: sha256File(join(PATHS.results, "splits", "development.jsonl")), sealed: sha256File(join(PATHS.results, "splits", "sealed.jsonl")), ood: sha256File(join(PATHS.results, "splits", "ood.jsonl")) } });
  const calibrationCanonicals = readdirSync(join(PATHS.results, "splits"))
    .filter((name) => name.startsWith("calibration-") && name.endsWith(".jsonl"))
    .flatMap((name) => (readJsonl(join(PATHS.results, "splits", name)) as Problem[]).map((problem) => problem.canonical));
  const blocked = [...new Set([...calibrationCanonicals, ...development, ...sealed, ...ood].map((problem) => (typeof problem === "string" ? problem : problem.canonical)))];
  writeJsonl(join(PATHS.artifacts, "forbidden", "heldout.txt"), blocked.map((canonical) => ({ canonical })));
  await import("node:fs").then((fs) => fs.writeFileSync(join(PATHS.artifacts, "forbidden", "heldout-canonicals.txt"), `${blocked.join("\n")}\n`));
  return { development, validation, sealed, ood, experience, supervisedPool };
}

async function runSeed(seed: number, splits: { experience: Problem[]; supervisedPool: Problem[]; validation: Problem[] }, baseSha256: string): Promise<{ seed: number; verified: ReturnType<typeof verifiedExamples>; match: ReturnType<typeof matchSupervised>; self?: AdapterInfo; supervised?: AdapterInfo }> {
  const perSeed = splits.experience.length / TRAINING_SEEDS.length;
  const offset = TRAINING_SEEDS.indexOf(seed as (typeof TRAINING_SEEDS)[number]) * perSeed;
  const problems = splits.experience.slice(offset, offset + perSeed);
  const attempts = await sampleAttempts(`experience-${seed}`, problems, seed, null);
  const verified = verifiedExamples(attempts);
  const match = matchSupervised(verified.examples, splits.supervisedPool);
  decide(`seed-${seed}-yield`, { attempts: verified.attempts, correct: verified.correctAttempts, unique: verified.examples.length, matched: match.self.length, sufficient: match.sufficient, easyDominated: match.easyDominated });
  let self: AdapterInfo | undefined;
  let supervised: AdapterInfo | undefined;
  if (match.sufficient) {
    self = await trainAdapter(`self-${seed}-r1`, seed, "self", match.self, splits.validation, true, match.easyDominated, true, baseSha256);
    supervised = await trainAdapter(`supervised-${seed}`, seed, "supervised", match.supervised, splits.validation, true, false, true, baseSha256);
  } else {
    const fallback = programmaticExamples(splits.supervisedPool.slice(0, Math.min(32, splits.supervisedPool.length)));
    supervised = await trainAdapter(`supervised-${seed}-unmatched`, seed, "supervised", fallback, splits.validation, false, false, true, baseSha256);
    decide(`seed-${seed}-self-skipped`, { reason: "verified yield was below the minimum or could not be matched", verified: verified.examples.length });
  }
  return { seed, verified, match, self, supervised };
}

async function trainAdapter(name: string, seed: number, condition: AdapterInfo["condition"], examples: TrainingExample[], validation: Problem[], matched: boolean, easyDominated: boolean, confirmatory: boolean, baseSha256: string): Promise<AdapterInfo> {
  const copied = join(PATHS.results, "training", `${name}.json`);
  if (existsSync(copied)) {
    return readJson(copied);
  }
  const dataDir = join(PATHS.artifacts, "data", name);
  const outputDir = join(PATHS.artifacts, "runs", name);
  mkdirSync(dataDir, { recursive: true });
  const forbidden = [...validation.map((problem) => problem.canonical)];
  assertNoCanonicalLeak(examples.map((example) => example.canonical), forbidden.concat(readHeldOut()));
  await import("node:fs").then((fs) => {
    fs.writeFileSync(join(dataDir, "train.jsonl"), `${examples.map((example) => toChatLine(example)).join("\n")}\n`);
    fs.writeFileSync(join(dataDir, "valid.jsonl"), `${programmaticExamples(validation).map((example) => toChatLine(example)).join("\n")}\n`);
  });
  await runWorker(
    {
      ...MODEL,
      command: "train",
      dataDir,
      outputDir,
      forbiddenCanonicalsPath: join(PATHS.artifacts, "forbidden", "heldout-canonicals.txt"),
      cancelPath: join(outputDir, "cancel"),
      seed,
      ...TRAIN_CONFIG,
    },
    `train-${name}`,
    40 * 60 * 1000,
  );
  const result = readJson<TrainResult>(join(outputDir, "result.json"));
  if (result.baseSha256 !== baseSha256 || result.baseUnchanged !== true || result.cancelled || result.adapterSha256 === null || result.artifactPath === null) {
    throw new Error(`training ${name} did not preserve the base checkpoint or did not produce an adapter`);
  }
  const info: AdapterInfo = {
    name,
    seed,
    condition,
    round: 1,
    confirmatory,
    sha256: result.adapterSha256,
    path: outputDir,
    examples: examples.length,
    steps: TRAIN_CONFIG.steps,
    durationMs: result.durationMs,
    peakMemoryBytes: result.peakMemoryBytes,
    matched,
    easyDominated,
  };
  writeJson(copied, { ...info, metrics: result.metrics, trainableParameters: result.trainableParameters, maskedTarget: result.maskedTarget, baseSha256: result.baseSha256 });
  return info;
}

async function exploratoryRounds(seeds: Array<{ seed: number; self?: AdapterInfo }>, baselineRetention: string, baseSha256: string): Promise<unknown[]> {
  const seed = seeds.find((item) => item.seed === 101);
  const rounds: unknown[] = [];
  if (seed?.self === undefined) {
    decide("exploratory-stopped", { reason: "seed 101 had no self-training adapter" });
    return rounds;
  }
  let previousAccuracy = accuracyOf(join(PATHS.results, "evals", "baseline-dev.jsonl"));
  let adapter = seed.self;
  for (let round = 1; round < 3; round += 1) {
    if (!existsSync(join(PATHS.results, "evals", `${adapter.name}-dev.jsonl`))) {
      const development = readJsonl(join(PATHS.results, "splits", "development.jsonl")) as Problem[];
      await evaluateProblems(`${adapter.name}-dev`, development, adapter);
      await evaluateRetention(`${adapter.name}-retention-dev`, retentionItems("retention-dev"), adapter);
    }
    const current = accuracyOf(join(PATHS.results, "evals", `${adapter.name}-dev.jsonl`));
    const retentionOk = retentionOkAgainst(baselineRetention, join(PATHS.results, "evals", `${adapter.name}-retention-dev.jsonl`));
    const decision = continueSelfTraining({ round, devGain: current - previousAccuracy, retentionOk, verifiedExamples: adapter.examples });
    decide(`exploratory-round-${round}`, { ...decision, devAccuracy: current, previousAccuracy });
    rounds.push({ round, decision, devAccuracy: current });
    if (!decision.continue) {
      break;
    }
    previousAccuracy = current;
    const cell = readJson<{ cell: TaskCell }>(join(PATHS.results, "frozen-task.json")).cell;
    const allocation = allocationFor(cell);
    const forbidden = currentForbidden();
    const fresh = generateProblems(cell, `experience-exploratory-${round + 1}`, allocation.experience / TRAINING_SEEDS.length, 12000 + round, forbidden);
    writeJsonl(join(PATHS.results, "splits", `experience-exploratory-${round + 1}.jsonl`), fresh);
    const attempts = await sampleAttempts(`experience-101-r${round + 1}`, fresh, 101, adapter);
    const verified = verifiedExamples(attempts);
    if (verified.examples.length < 16) {
      decide("exploratory-stopped", { reason: "the later round did not yield enough new verified examples", round: round + 1 });
      break;
    }
    const validation = readJsonl(join(PATHS.results, "splits", "validation.jsonl")) as Problem[];
    adapter = await trainAdapter(`self-101-r${round + 1}`, 101, "self", verified.examples, validation, false, false, false, baseSha256);
    rounds.push({ round: round + 1, note: "trained from the base checkpoint on this round's verified examples; not evaluated on the sealed holdout" });
  }
  return rounds;
}

async function sampleAttempts(name: string, problems: Problem[], seed: number, adapter: AdapterInfo | null): Promise<Array<{ item: Problem; attemptId: string; response: string; seed: number }>> {
  const path = join(PATHS.results, "experience", `${name}.jsonl`);
  if (existsSync(path)) {
    const saved = readJsonl(path) as Array<{ item: Problem; attemptId: string; response: string; seed: number }>;
    const allowed = new Set(problems.map((problem) => problem.itemId));
    if (saved.length > 0 && saved.every((attempt) => allowed.has(attempt.item.itemId))) {
      return saved;
    }
  }
  const samples = readJson<{ allocation: { samplesPerProblem: number } }>(join(PATHS.results, "frozen-task.json")).allocation.samplesPerProblem;
  const items = problems.flatMap((problem) =>
    Array.from({ length: samples }, (_unused, index) => ({
      id: `${problem.itemId}#${index}`,
      prompt: problem.prompt,
      seed: attemptSeed(seed, problem.itemId, index),
      attemptId: String(index),
    })),
  );
  const predictions = await predict(name, items, SAMPLE_DECODING, adapter);
  const byId = new Map(problems.map((problem) => [problem.itemId, problem]));
  const attempts = predictions.predictions.map((prediction) => {
    const itemId = prediction.id.split("#")[0] ?? prediction.id;
    const item = byId.get(itemId);
    if (item === undefined) {
      throw new Error(`prediction ${prediction.id} has no source problem`);
    }
    return { item, attemptId: prediction.attemptId, response: prediction.response, seed: prediction.seed };
  });
  writeJsonl(path, attempts);
  return attempts;
}

async function evaluateProblems(name: string, problems: Problem[], adapter: AdapterInfo | null): Promise<string> {
  const destination = join(PATHS.results, "evals", `${name}.jsonl`);
  if (existsSync(destination)) {
    return destination;
  }
  const predictions = await predict(
    name,
    problems.map((problem) => ({ id: problem.itemId, prompt: problem.prompt, seed: 0, attemptId: "0" })),
    EVAL_DECODING,
    adapter,
  );
  const byId = new Map(predictions.predictions.map((prediction) => [prediction.id, prediction]));
  const records: StoredEval[] = problems.map((problem) => {
    const prediction = byId.get(problem.itemId);
    if (prediction === undefined) {
      throw new Error(`missing prediction for ${problem.itemId}`);
    }
    const scored = scoreInteger(prediction.response, problem.expected);
    return record(name, problem.itemId, "arithmetic", problem.prompt, prediction, problem.expected, "integer", scored.correct, scored.formatValid, adapter);
  });
  writeJsonl(destination, records);
  return destination;
}

async function evaluateRetention(name: string, items: RetentionItem[], adapter: AdapterInfo | null): Promise<string> {
  const destination = join(PATHS.results, "evals", `${name}.jsonl`);
  if (existsSync(destination)) {
    return destination;
  }
  const predictions = await predict(
    name,
    items.map((item) => ({ id: item.itemId, prompt: item.prompt, seed: 0, attemptId: "0" })),
    EVAL_DECODING,
    adapter,
  );
  const byId = new Map(predictions.predictions.map((prediction) => [prediction.id, prediction]));
  const records: StoredEval[] = items.map((item) => {
    const prediction = byId.get(item.itemId);
    if (prediction === undefined) {
      throw new Error(`missing retention prediction for ${item.itemId}`);
    }
    const expected = expectedFromRetentionPrompt(item.category, item.prompt);
    const correct = item.scoreMode === "exact" ? scoreExact(prediction.response, String(expected)).correct : scoreInteger(prediction.response, Number(expected)).correct;
    const formatValid = item.scoreMode === "exact" ? correct : scoreInteger(prediction.response, Number(expected)).formatValid;
    return { ...record(name, item.itemId, item.split, item.prompt, prediction, expected, item.scoreMode, correct, formatValid, adapter), category: item.category };
  });
  writeJsonl(destination, records);
  return destination;
}

async function predict(name: string, items: Array<{ id: string; prompt: string; seed: number; attemptId: string }>, decoding: { temperature: number; topP: number; maxTokens: number; thinking: string }, adapter: AdapterInfo | null): Promise<PredictionFile> {
  const outputPath = join(PATHS.artifacts, "predictions", `${name}.json`);
  if (!existsSync(outputPath)) {
    const chunks = [];
    for (let index = 0; index < items.length; index += 400) {
      chunks.push(items.slice(index, index + 400));
    }
    const predictions = [];
    let payload: PredictionFile | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const chunkPath = join(PATHS.artifacts, "predictions", `${name}-${index}.json`);
      if (!existsSync(chunkPath)) {
        await runWorker(
          {
            ...MODEL,
            command: "generate",
            outputPath: chunkPath,
            items: chunk,
            temperature: decoding.temperature,
            topP: decoding.topP,
            maxTokens: decoding.maxTokens,
            thinking: decoding.thinking,
            adapterPath: adapter?.path ?? null,
            expectedAdapterSha256: adapter?.sha256 ?? null,
          },
          `generate-${name}-${index}`,
          50 * 60 * 1000,
        );
      }
      payload = readJson<PredictionFile>(chunkPath);
      if (adapter && payload.adapterSha256 !== adapter.sha256) {
        throw new Error(`generation ${name} did not load the expected adapter`);
      }
      predictions.push(...payload.predictions);
    }
    writeJson(outputPath, { ...payload, predictions });
  }
  return readJson<PredictionFile>(outputPath);
}

function record(runId: string, itemId: string, split: string, prompt: string, prediction: PredictionFile["predictions"][number], expected: number | string, scoreMode: "integer" | "exact", correct: boolean, formatValid: boolean, adapter: AdapterInfo | null): StoredEval {
  return {
    experimentId: EXPERIMENT_ID,
    evaluationRunId: runId,
    itemId,
    split,
    datasetVersion: GENERATOR_VERSION,
    prompt,
    response: prediction.response,
    expectedAnswer: expected,
    scoreMode,
    modelId: MODEL.modelId,
    modelRevision: MODEL.modelRevision,
    adapterId: adapter?.name ?? null,
    adapterSha256: adapter?.sha256 ?? null,
    seed: prediction.seed,
    decoding: EVAL_DECODING,
    attemptId: prediction.attemptId,
    correct,
    formatValid,
    latencyMs: prediction.latencyMs,
    promptTokens: prediction.promptTokens,
    completionTokens: prediction.completionTokens,
  } as StoredEval;
}

function renderReport(input: {
  context: { startedAt: string; hardware: unknown; policies: { gateHash: string; improvementHash: string } };
  probe: { baseSha256: string; peakMemoryBytes: number | null; layers: number; quantization: unknown; maskedTarget: string; durationMs: number };
  frozen: { cell: TaskCell; allocation: ReturnType<typeof allocationFor>; selection: { id: string; inBand: boolean; bandMissed: boolean } };
  splits: { sealed: Problem[]; ood: Problem[] };
  baselineDev: string;
  sealed: string;
  ood: string;
  retention: string;
  seeds: Array<{ seed: number; verified: ReturnType<typeof verifiedExamples>; match: ReturnType<typeof matchSupervised>; self?: AdapterInfo; supervised?: AdapterInfo }>;
  exploratory: unknown[];
  candidateEvals: Array<{ adapter: AdapterInfo; sealed: string; ood: string; retention: string }>;
}): string {
  const baseSealed = summarizeRun(readJsonl(input.sealed) as StoredEval[]);
  const baseOod = summarizeRun(readJsonl(input.ood) as StoredEval[]);
  const baseRetention = retentionRates(input.retention);
  const lines = [
    "# M7.5 Phase 1 research report",
    "",
    `Experiment \`${EXPERIMENT_ID}\` started ${input.context.startedAt}. Phase 2 was not started. No adapter was promoted or assigned to an operational department.`,
    "",
    "## Model",
    "",
    `Checkpoint \`${REQUESTED_MODEL_ID}\`, revision \`${PRIMARY_REVISION}\`. Architecture Qwen3, ${input.probe.layers} layers, quantization ${JSON.stringify(input.probe.quantization)}. Base weight hash \`${input.probe.baseSha256}\`. Probe loss-mask target: \`${input.probe.maskedTarget.replaceAll("\n", "\\n")}\`. Probe peak memory ${input.probe.peakMemoryBytes ?? "unknown"} bytes in ${input.probe.durationMs} ms.`,
    "",
    `The requested repository exists. This is not the mlx-community conversion. Thinking is constrained with a closed empty \`<think>\` prefix so training targets stay verified integers. ${FALLBACK_MODEL_ID} was not used.`,
    "",
    "## Task",
    "",
    `Selected cell \`${input.frozen.cell.id}\` after development calibration. In band: ${input.frozen.selection.inBand}. Band missed: ${input.frozen.selection.bandMissed}. ${input.frozen.allocation.note}`,
    "",
    `Generator \`${GENERATOR_VERSION}\`. Scorer \`${SCORER_VERSION}\`. Sealed items: ${input.splits.sealed.length}. OOD items: ${input.splits.ood.length}. Development baseline accuracy: ${accuracyOf(input.baselineDev).toFixed(4)}.`,
    "",
    "## Baseline sealed holdout",
    "",
    `${baseSealed.taskCorrect}/${baseSealed.sampleSize} task-correct (${baseSealed.taskAccuracy.toFixed(4)}), format ${baseSealed.formatValid}/${baseSealed.sampleSize}, Wilson interval ${baseSealed.interval.low.toFixed(4)}–${baseSealed.interval.high.toFixed(4)}.`,
    "",
    "## Candidates",
    "",
  ];
  const conclusions = [];
  for (const candidate of input.candidateEvals) {
    const task = summarizeRun(readJsonl(candidate.sealed) as StoredEval[]);
    const oodSummary = summarizeRun(readJsonl(candidate.ood) as StoredEval[]);
    const retention = retentionRates(candidate.retention);
    const retentionDrop = retentionFailed(baseRetention["record-extraction"] ?? 0, retention["record-extraction"] ?? 0) || retentionFailed(baseRetention["exact-copy"] ?? 0, retention["exact-copy"] ?? 0);
    const compared = compareRuns(readJsonl(input.sealed) as StoredEval[], readJsonl(candidate.sealed) as StoredEval[], retentionDrop);
    const gate = compared.comparison === null ? null : decideGate({ domain: "arithmetic", paired: compared.comparison, baselineFormat: baseSealed.formatAccuracy, candidateFormat: task.formatAccuracy, checksumsMatch: true, contaminated: false });
    const policy = compared.comparison === null ? null : verifyImprovement({
      sampleSize: compared.comparison.sampleSize,
      taskBaseline: compared.comparison.baselineAccuracy,
      taskCandidate: compared.comparison.candidateAccuracy,
      formatBaseline: baseSealed.formatAccuracy,
      formatCandidate: task.formatAccuracy,
      baselineOnly: compared.comparison.baselineOnly,
      candidateOnly: compared.comparison.candidateOnly,
      taskBaselineCorrect: compared.comparison.bothCorrect + compared.comparison.baselineOnly,
      taskCandidateCorrect: compared.comparison.bothCorrect + compared.comparison.candidateOnly,
      checksumsMatch: true,
      contaminated: false,
      familyCompatible: true,
      evaluationPresent: true,
      benchmarkValid: true,
      retentionPresent: true,
      retentionPassed: !retentionFailed(baseRetention["record-extraction"] ?? 0, retention["record-extraction"] ?? 0) && !retentionFailed(baseRetention["exact-copy"] ?? 0, retention["exact-copy"] ?? 0),
    });
    conclusions.push({ name: candidate.adapter.name, condition: candidate.adapter.condition, seed: candidate.adapter.seed, research: compared.conclusion, bonferroni: compared.bonferroni, policy: policy?.classification ?? null, gate: gate?.decision ?? null, difference: compared.comparison?.difference ?? null, pValue: compared.comparison?.pValue ?? null });
    lines.push(`### ${candidate.adapter.name}`);
    lines.push("");
    lines.push(`Condition ${candidate.adapter.condition}, seed ${candidate.adapter.seed}, examples ${candidate.adapter.examples}, steps ${candidate.adapter.steps}, adapter \`${candidate.adapter.sha256}\`, train ${candidate.adapter.durationMs} ms, peak ${candidate.adapter.peakMemoryBytes ?? "unknown"} bytes. Matched to the other condition: ${candidate.adapter.matched}.`);
    lines.push("");
    lines.push(`Sealed ${task.taskCorrect}/${task.sampleSize} (${task.taskAccuracy.toFixed(4)}). OOD ${oodSummary.taskCorrect}/${oodSummary.sampleSize} (${oodSummary.taskAccuracy.toFixed(4)}). Baseline OOD ${baseOod.taskCorrect}/${baseOod.sampleSize} (${baseOod.taskAccuracy.toFixed(4)}).`);
    lines.push("");
    lines.push(`Paired difference ${compared.comparison?.difference ?? "unavailable"}, McNemar p ${compared.comparison?.pValue ?? "unavailable"}, research ${compared.conclusion}, Bonferroni survivor ${compared.bonferroni}. Frozen M6 gate ${gate?.decision ?? "unavailable"}. Unchanged m7h policy ${policy?.classification ?? "unavailable"}. Deployment ${phase1Decision(compared.conclusion).deployment}.`);
    lines.push("");
    lines.push(`Confirmatory retention: extraction ${retention["record-extraction"] ?? "missing"} versus baseline ${baseRetention["record-extraction"] ?? "missing"}; exact copy ${retention["exact-copy"] ?? "missing"} versus baseline ${baseRetention["exact-copy"] ?? "missing"}.`);
    lines.push("");
  }
  const byCondition = new Map<string, typeof conclusions>();
  for (const item of conclusions) {
    const list = byCondition.get(item.condition) ?? [];
    list.push(item);
    byCondition.set(item.condition, list);
  }
  lines.push("## Reproducibility and scientific status");
  lines.push("");
  let scientific = "FAIL";
  for (const [condition, items] of byCondition) {
    const positive = items.filter((item) => item.research === "POSITIVE_EVIDENCE");
    const adjusted = positive.filter((item) => item.bonferroni);
    lines.push(`${condition}: ${items.length} confirmatory seeds, ${positive.length} with nominal positive evidence, ${adjusted.length} surviving Bonferroni (${(0.05 / 6).toFixed(4)}).`);
    if (items.length >= 2 && adjusted.length >= 2) {
      scientific = "PASS";
    }
  }
  lines.push("");
  lines.push(`Scientific completion: ${scientific}. A single seed, a nominal p-value that does not survive the six-test Bonferroni correction, or a retention failure is not scientific completion. Engineering completion is recorded in the manifest only when this report was written after sealed evaluation.`);
  lines.push("");
  lines.push("## Yield");
  lines.push("");
  for (const seed of input.seeds) {
    lines.push(`Seed ${seed.seed}: attempts ${seed.verified.attempts}, correct attempts ${seed.verified.correctAttempts}, unique verified ${seed.verified.examples.length}, matched ${seed.match.self.length}, sufficient ${seed.match.sufficient}, answer-cap dropped ${seed.match.answerCapDropped}, easy-dominated ${seed.match.easyDominated}.`);
  }
  lines.push("");
  lines.push("## Exploration");
  lines.push("");
  lines.push(input.exploratory.length === 0 ? "No later self-training round was run." : JSON.stringify(input.exploratory));
  lines.push("");
  lines.push("Later rounds, when trained, started again from the base checkpoint and were not scored on the sealed holdout.");
  lines.push("");
  lines.push("## Policies");
  lines.push("");
  lines.push(`Frozen gate \`${GATE_POLICY.version}\` hash \`${input.context.policies.gateHash}\`. Improvement policy \`${IMPROVEMENT_POLICY.version}\` hash \`${input.context.policies.improvementHash}\`. Neither policy was edited. Research conclusions do not require Wilson-interval separation. A safety-gate PASS is not an improvement. Phase 1 deployment eligibility is ineligible for every candidate.`);
  lines.push("");
  lines.push("## What this does not show");
  lines.push("");
  lines.push("The colony did not run this training. Math did not receive the adapter. Qwen3-8B was not fine-tuned. A 1.7B adapter cannot be applied to Qwen3-8B. Self-generated targets are verified integers, not unverified reasoning traces. Arithmetic has exact programmatic labels, so a weak self-training result does not show that self-training is useless where labels are expensive. Retention on two short checks does not rule out forgetting in general. No claim is made about general intelligence or continual learning.");
  lines.push("");
  lines.push("## Operational options, not implemented");
  lines.push("");
  lines.push("Specialist routing could send arithmetic subtasks to this 1.7B checkpoint plus an adapter. That adds a second model in memory and needs its own sealed evaluation inside the Math workflow. Training a LoRA on operational Qwen3-8B would match the serving model but should not run while that 8B model is loaded, and it was not attempted. Either path needs a new authorization and a Phase 2 decision.");
  lines.push("");
  lines.push("## Reproduction");
  lines.push("");
  lines.push("```bash");
  lines.push("pnpm exec tsx scripts/run-m75-phase1.ts");
  lines.push("pnpm exec tsx research/m75/score.ts services/training/results/m75/evals");
  lines.push("```");
  lines.push("");
  lines.push("The scorer recomputes correctness from the prompt and the full response. Adapter weights remain under `services/training/research-artifacts` and are identified by SHA-256.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function retentionRates(path: string): Record<string, number> {
  const records = readJsonl(path) as StoredEval[];
  const groups = new Map<string, StoredEval[]>();
  for (const record of records) {
    const key = record.category ?? "unknown";
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  return Object.fromEntries([...groups.entries()].map(([key, group]) => [key, summarizeRun(group).taskAccuracy]));
}

function accuracyOf(path: string): number {
  return summarizeRun(readJsonl(path) as StoredEval[]).taskAccuracy;
}

function retentionOkAgainst(baselinePath: string, candidatePath: string): boolean {
  const baseline = retentionRates(baselinePath);
  const candidate = retentionRates(candidatePath);
  return !retentionFailed(baseline["record-extraction"] ?? 0, candidate["record-extraction"] ?? 0) && !retentionFailed(baseline["exact-copy"] ?? 0, candidate["exact-copy"] ?? 0);
}

function absorb(forbidden: { canonicals: Set<string>; templates: Set<string> }, problems: Problem[]): void {
  for (const problem of problems) {
    forbidden.canonicals.add(problem.canonical);
    forbidden.templates.add(problem.templateKey);
  }
}

function currentForbidden(): { canonicals: Set<string>; templates: Set<string> } {
  const forbidden = { canonicals: new Set<string>(), templates: new Set<string>() };
  for (const name of readdirSync(join(PATHS.results, "splits")).filter((entry) => entry.endsWith(".jsonl"))) {
    absorb(forbidden, readJsonl(join(PATHS.results, "splits", name)) as Problem[]);
  }
  return forbidden;
}

function readHeldOut(): string[] {
  return (readJsonl(join(PATHS.artifacts, "forbidden", "heldout.txt")) as Array<{ canonical: string }>).map((item) => item.canonical);
}

function attemptSeed(trainingSeed: number, itemId: string, attempt: number): number {
  return createHash("sha256").update(`${trainingSeed}|${itemId}|${attempt}`).digest().readUInt32BE(0) & 0x7fffffff;
}

function decide(event: string, detail: unknown): void {
  mkdirSync(PATHS.results, { recursive: true });
  appendFileSync(join(PATHS.results, "decisions.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`);
}

function hardware(): unknown {
  return { cpu: cpus()[0]?.model ?? "unknown", totalMemBytes: totalmem(), freeMemBytes: freemem(), platform: process.platform };
}

function unloadOllama(): unknown {
  const listed = command("ollama", ["ps"]);
  const lines = listed.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0]).filter((name): name is string => name !== undefined && name.length > 0 && name !== "NAME");
  const stopped = lines.map((name) => ({ name, result: command("ollama", ["stop", name]) }));
  return { listed, stopped, freeMemBytes: freemem() };
}

function command(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.error) {
    return `unavailable:${result.error.message}`;
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function hashResults(): Record<string, string> {
  const hashes: Record<string, string> = {};
  const evalDir = join(PATHS.results, "evals");
  if (existsSync(evalDir)) {
    for (const name of readdirSync(evalDir)) {
      hashes[`evals/${name}`] = sha256File(join(evalDir, name));
    }
  }
  return hashes;
}
