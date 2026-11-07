const STANDALONE_ESCAPES = new Set(["b", "f", "n", "r", "t"]);
const LATEX_TAILS: Record<string, readonly string[]> = {
  b: ["egin", "eta"],
  f: ["rac"],
  n: ["abla"],
  r: ["ight"],
  t: ["au", "ext", "heta", "imes"],
};

export interface ParsedModelJson {
  value: unknown;
  repaired: boolean;
  raw: string;
  parsedText: string;
}

export function repairJsonStringEscapes(raw: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index] ?? "";
    if (!inString) {
      out += current;
      if (current === "\"") {
        inString = true;
      }
      continue;
    }
    if (current === "\"") {
      out += current;
      inString = false;
      continue;
    }
    if (current !== "\\") {
      out += current;
      continue;
    }
    const next = raw[index + 1];
    if (!next) {
      out += "\\\\";
      continue;
    }
    if (next === "\"" || next === "\\" || next === "/") {
      out += `\\${next}`;
      index += 1;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}/.test(raw.slice(index + 2, index + 6))) {
      out += raw.slice(index, index + 6);
      index += 5;
      continue;
    }
    const rest = raw.slice(index + 2);
    if (STANDALONE_ESCAPES.has(next) && !(LATEX_TAILS[next] ?? []).some((tail) => rest.startsWith(tail))) {
      out += `\\${next}`;
      index += 1;
      continue;
    }
    out += `\\\\${next}`;
    index += 1;
  }
  return out;
}

export function suspiciousMathControls(text: string): boolean {
  return /[\u0008\u000c]/.test(text) || /\n(?:abla|eq|u)\b/.test(text) || /\t(?:heta|ext|imes|au)\b/.test(text);
}

export function parseModelJson(text: string): ParsedModelJson {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Model output did not contain a JSON object");
  }
  const slice = raw.slice(start, end + 1);
  const direct = tryParse(slice);
  const repaired = repairJsonStringEscapes(slice);
  const fixed = repaired === slice ? direct : tryParse(repaired);
  if (direct && !stringValues(direct).some(suspiciousMathControls)) {
    return { value: direct, repaired: false, raw: slice, parsedText: slice };
  }
  if (fixed) {
    return { value: fixed, repaired: repaired !== slice, raw: slice, parsedText: repaired };
  }
  if (direct) {
    return { value: direct, repaired: false, raw: slice, parsedText: slice };
  }
  throw new Error("output was not valid JSON");
}

export type ClaimStatus = "verified" | "external" | "experiment" | "hypothesis" | "pending" | "unsupported" | "statement";

export type ContributionValidation =
  | { ok: true }
  | { ok: false; reason: string };

const META_VALIDATION_PATTERNS = [
  /previous json failed validation/i,
  /corrected json object/i,
  /here is the corrected json/i,
  /did not include the required fields/i,
  /required fields?\s+['"]?kind['"]?/i,
  /return one json object/i,
  /validation errors?:/i,
  /model_invalid:/i,
  /output was not (?:a json object|valid json)/i,
  /do not omit kind or body/i,
];

const RESEARCH_CONTEXT = /\b(?:hypothesis|experiment|equation|derivation|forgetting|accuracy|loss|parameter|task|dataset|metric|protocol|assumption|learning rate|ewc|replay)\b/i;

export function validateContribution(input: { kind: string; body: string }): ContributionValidation {
  const body = input.body.trim();
  if (!body) {
    return { ok: false, reason: "body is empty" };
  }
  if (body.length < 12) {
    return { ok: false, reason: "body has no substantive contribution" };
  }
  const metaHits = META_VALIDATION_PATTERNS.filter((pattern) => pattern.test(body)).length;
  if (metaHits >= 1 && !RESEARCH_CONTEXT.test(body)) {
    return { ok: false, reason: "body is a parser or validation explanation" };
  }
  if (metaHits >= 2) {
    return { ok: false, reason: "body is dominated by internal validation instructions" };
  }
  if (/^(?:here is the corrected|the previous json failed)/i.test(body)) {
    return { ok: false, reason: "body opens as a formatting correction" };
  }
  if (/^\s*\{[\s\S]*"kind"\s*:/.test(body) && body.includes("\"body\"")) {
    return { ok: false, reason: "body contains nested decision JSON instead of research text" };
  }
  const words = body.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 3) {
    return { ok: false, reason: "body has no substantive contribution after normalization" };
  }
  return { ok: true };
}

export function classifyClaim(kind: string, body: string): ClaimStatus {
  if (/\bhypothesis\b|\bwe assume\b|\bassume that\b/i.test(body)) {
    return "hypothesis";
  }
  if (/pending verification/i.test(body)) {
    return "pending";
  }
  if (kind !== "evidence") {
    return "statement";
  }
  if (/\bobserved:\s+\S+/i.test(body)) {
    return "verified";
  }
  if (/\bexperiment:\s+\S+/i.test(body)) {
    return "experiment";
  }
  if (/\b(?:doi:|source:|https?:\/\/)\S+/i.test(body)) {
    return "external";
  }
  return "unsupported";
}

export interface MathReview {
  status: "none" | "proposed" | "flagged" | "unverified";
  reasons: string[];
  verification: "unverified";
}

export function reviewMathClaim(body: string, priorBodies: readonly string[] = []): MathReview {
  const equation = /[=∇]|\\frac|\\nabla|\\theta|\\eta|\bpartial\b/i.test(body) || /\b(?:learning rate|fisher|ewc)\b/i.test(body);
  const claimedProof = /\bproof\b/i.test(body) && !/\b(?:assume|let|therefore|qed|steps?:)\b/i.test(body);
  if (!equation && !claimedProof) {
    return { status: "none", reasons: [], verification: "unverified" };
  }
  const reasons: string[] = [];
  if (equation && !/\b(?:assume|assumption|define|definition|let|where)\b/i.test(body)) {
    reasons.push("missing_assumptions");
  }
  if (equation && !/\b(?:because|therefore|derive|derivation|example|worked)\b/i.test(body)) {
    reasons.push("missing_derivation");
  }
  if (claimedProof) {
    reasons.push("claimed_proof_without_steps");
  }
  if (conflictingLearningRate(body, priorBodies)) {
    reasons.push("conflicting_variable_definition");
  }
  if (/symmetric|two-task forgetting/i.test(body) && !/\b(?:assume|because|therefore|example)\b/i.test(body)) {
    reasons.push("unsupported_formulation");
  }
  const sides = body.split("=").map((side) => unitsIn(side));
  if (sides.length === 2 && sides[0]?.size && sides[1]?.size && [...sides[0]].every((unit) => !sides[1]?.has(unit))) {
    reasons.push("dimensional_mismatch");
  }
  if (/\b(?:calculation|compute|equals)\b/i.test(body) && !/\d/.test(body) && !/[=≈]/.test(body)) {
    reasons.push("claimed_calculation_without_steps");
  }
  return {
    status: reasons.length > 0 ? "flagged" : "proposed",
    reasons,
    verification: "unverified",
  };
}

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "what", "which", "how", "is", "are", "was", "this", "that", "for", "with", "we", "our", "does", "do", "can", "without", "from", "into", "on", "in", "it", "be"]);
const SUPERFICIAL = new Set([
  "method", "methods", "framework", "approach", "approaches", "model", "models", "system", "systems",
  "process", "important", "effective", "effectiveness", "ability", "critical", "nature", "structure",
  "learning", "continual", "catastrophic", "forgetting", "previous", "earlier", "also", "however",
  "therefore", "thus", "using", "based", "such", "these", "those", "their", "them", "than", "then",
  "still", "remain", "remains", "against", "assume", "assumes", "prevent", "prevents", "under", "static", "data",
]);

export type NoveltyClass =
  | "derivation"
  | "correction"
  | "hypothesis"
  | "experiment"
  | "evidence"
  | "synthesis"
  | "rebuttal"
  | "clarification"
  | "superficial"
  | "distinct";

export function classifyNovelty(body: string, prior: readonly { kind: string; body: string }[]): {
  duplicate: boolean;
  novel: boolean;
  class: NoveltyClass;
  reason: string;
} {
  const current = contentWords(body);
  const substantiveFresh = (previous: Set<string>) => [...current].filter((word) => !previous.has(word) && !SUPERFICIAL.has(word));
  const hasProvenance = /\bobserved:\b|\bexperiment:\b|\bdoi:\b|\bsource:\b/i.test(body);
  const hasNumericWork = /\d/.test(body) && /[=+\-*/]/.test(body);
  const isCorrection = /\b(?:incorrect|correction:|superseded|should be|η|eta)\b/i.test(body) && /\b(?:learning rate|definition|variable)\b/i.test(body);
  const isHypothesis = /\b(?:hypothesis|falsifiable)\b/i.test(body);
  const isExperiment = /\b(?:experiment|control|metric|protocol|dataset)\b/i.test(body);
  const isSynthesis = /\b(?:synthesis|next action|agreed|conclusion)\b/i.test(body);
  const isRebuttal = /\b(?:challenge|however|does not follow|unsupported|contradict)\b/i.test(body);

  for (const turn of prior) {
    const previous = contentWords(turn.body);
    const overlap = jaccard(current, previous);
    const fresh = substantiveFresh(previous);
    const hasNewNumber = numbersIn(body).some((value) => !numbersIn(turn.body).includes(value));
    const bothQuestions = /\?/.test(body) && /\?/.test(turn.body);
    const sameQuestion = bothQuestions && intersectionCount(current, previous) >= 4 && fresh.length < 3 && !hasProvenance && !hasNumericWork && !hasNewNumber;
    if ((overlap >= 0.62 && fresh.length < 3 && !hasProvenance && !hasNumericWork && !hasNewNumber && !isCorrection) || sameQuestion) {
      return { duplicate: true, novel: false, class: "superficial", reason: "The turn rephrases an earlier claim without a new derivation, correction, hypothesis, experiment, or evidence." };
    }
    if (overlap >= 0.45 && fresh.length < 4 && !hasProvenance && !hasNumericWork && !hasNewNumber && !isCorrection && !isHypothesis && !isExperiment && !isRebuttal) {
      return { duplicate: true, novel: false, class: "superficial", reason: "The turn adds only superficial terminology to an earlier proposal." };
    }
    if (isCorrection) {
      return { duplicate: false, novel: true, class: "correction", reason: "The turn corrects a previous mathematical definition or claim." };
    }
    if (hasNumericWork && /\b(?:because|therefore|derive|example|let|where)\b/i.test(body)) {
      return { duplicate: false, novel: true, class: "derivation", reason: "The turn adds a worked calculation or derivation." };
    }
    if (hasProvenance) {
      return { duplicate: false, novel: true, class: "evidence", reason: "The turn adds evidence with provenance." };
    }
    if (isExperiment && fresh.length >= 1) {
      return { duplicate: false, novel: true, class: "experiment", reason: "The turn proposes an experiment, control, or metric." };
    }
    if (isHypothesis && fresh.length >= 1) {
      return { duplicate: false, novel: true, class: "hypothesis", reason: "The turn states a new or revised falsifiable hypothesis." };
    }
    if (isSynthesis && fresh.length >= 1) {
      return { duplicate: false, novel: true, class: "synthesis", reason: "The turn synthesizes findings and next actions." };
    }
    if (isRebuttal && fresh.length >= 1) {
      return { duplicate: false, novel: true, class: "rebuttal", reason: "The turn challenges or corrects prior reasoning." };
    }
    if (overlap >= 0.5 && fresh.length >= 3) {
      return { duplicate: false, novel: true, class: "clarification", reason: "The turn revisits an earlier point with substantive new terms." };
    }
  }
  if (isCorrection) {
    return { duplicate: false, novel: true, class: "correction", reason: "The turn corrects a previous mathematical definition or claim." };
  }
  return { duplicate: false, novel: current.size > 0, class: "distinct", reason: "The turn adds a distinct contribution." };
}

export function repetitionVerdict(
  body: string,
  prior: readonly { kind: string; body: string }[],
): { duplicate: boolean; novel: boolean; reason: string } {
  const classified = classifyNovelty(body, prior);
  return { duplicate: classified.duplicate, novel: classified.novel, reason: classified.reason };
}

export interface CheckpointTurn {
  id: string;
  department: string;
  kind: string;
  body: string;
  addressedDepartment: string | null;
}

export interface ConversationCheckpoint {
  objective: string;
  instruction: string;
  successCriteria: string[];
  facts: string[];
  hypotheses: string[];
  assumptions: string[];
  openQuestions: string[];
  agreements: string[];
  disagreements: string[];
  proposals: string[];
  decisions: string[];
  rejected: string[];
  verifiedEvidence: string[];
  unverifiedAssertions: string[];
  nextActions: string[];
  turnIndex: string[];
  byDepartment: Record<string, number>;
}

export function buildCheckpoint(input: {
  topic: string;
  instruction: string;
  turns: readonly CheckpointTurn[];
}): ConversationCheckpoint {
  const openQuestions: string[] = [];
  const facts: string[] = [];
  const hypotheses: string[] = [];
  const assumptions: string[] = [];
  const agreements: string[] = [];
  const disagreements: string[] = [];
  const proposals: string[] = [];
  const decisions: string[] = [];
  const rejected: string[] = [];
  const verifiedEvidence: string[] = [];
  const unverifiedAssertions: string[] = [];
  const nextActions: string[] = [];
  const byDepartment: Record<string, number> = {};
  for (let index = 0; index < input.turns.length; index += 1) {
    const turn = input.turns[index];
    if (!turn) {
      continue;
    }
    byDepartment[turn.department] = (byDepartment[turn.department] ?? 0) + 1;
    const line = cite(turn);
    const status = classifyClaim(turn.kind, turn.body);
    if (turn.kind === "question" && !answered(input.turns, index)) {
      openQuestions.push(`${line} owner=${turn.addressedDepartment ?? "unassigned"}`);
    }
    if (turn.kind === "agreement") {
      agreements.push(line);
    }
    if (turn.kind === "disagreement" || turn.kind === "challenge" || turn.kind === "counterargument") {
      disagreements.push(line);
    }
    if (turn.kind === "proposal") {
      proposals.push(line);
    }
    if (turn.kind === "resolution") {
      decisions.push(line);
    }
    if (status === "hypothesis" || /\bassumption\b/i.test(turn.body)) {
      hypotheses.push(line);
      assumptions.push(line);
    }
    if (status === "verified" || status === "external" || status === "experiment") {
      verifiedEvidence.push(`${status} ${line}`);
      facts.push(line);
    }
    if (status === "unsupported" || status === "pending") {
      unverifiedAssertions.push(`${status} ${line}`);
    }
    if (/\b(?:incorrect|superseded|correction:)\b/i.test(turn.body)) {
      rejected.push(line);
    }
    if (/\b(?:next|experiment|measure|test)\b/i.test(turn.body)) {
      nextActions.push(line);
    }
  }
  return {
    objective: input.topic,
    instruction: input.instruction,
    successCriteria: successCriteria(input.instruction),
    facts,
    hypotheses,
    assumptions,
    openQuestions,
    agreements,
    disagreements,
    proposals,
    decisions,
    rejected,
    verifiedEvidence,
    unverifiedAssertions,
    nextActions,
    turnIndex: input.turns.map(cite),
    byDepartment,
  };
}

export function renderCheckpoint(checkpoint: ConversationCheckpoint): string {
  const sections = [
    ["Original objective", checkpoint.objective],
    ["Original instruction", checkpoint.instruction],
    ["Success criteria", lines(checkpoint.successCriteria)],
    ["Established facts", lines(checkpoint.facts)],
    ["Hypotheses", lines(checkpoint.hypotheses)],
    ["Assumptions", lines(checkpoint.assumptions)],
    ["Open questions", lines(checkpoint.openQuestions)],
    ["Agreements", lines(checkpoint.agreements)],
    ["Disagreements", lines(checkpoint.disagreements)],
    ["Proposals", lines(checkpoint.proposals)],
    ["Decisions", lines(checkpoint.decisions)],
    ["Rejected claims", lines(checkpoint.rejected)],
    ["Verified evidence", lines(checkpoint.verifiedEvidence)],
    ["Unverified assertions", lines(checkpoint.unverifiedAssertions)],
    ["Next actions", lines(checkpoint.nextActions)],
    ["Turn index", lines(checkpoint.turnIndex)],
    ["Department contributions", Object.entries(checkpoint.byDepartment).map(([slug, count]) => `${slug}: ${count}`).join("; ") || "(none)"],
  ];
  return sections.map(([label, value]) => `${label}:\n${value}`).join("\n");
}

export function measureProgress(checkpoint: ConversationCheckpoint, turnCount: number): { substantial: boolean; reason: string } {
  if (checkpoint.verifiedEvidence.length > 0 || checkpoint.decisions.length > 0) {
    return { substantial: true, reason: "A verified result or an explicit decision is recorded." };
  }
  if (checkpoint.proposals.length > 0 && checkpoint.nextActions.length > 0) {
    return { substantial: true, reason: "A proposal names a concrete next action." };
  }
  if (checkpoint.disagreements.length > 0 && checkpoint.rejected.length > 0) {
    return { substantial: true, reason: "A disagreement produced a correction." };
  }
  return { substantial: false, reason: `${turnCount} turns are recorded, and none yet verifies a result or completes a deliverable.` };
}

export function requestsObjectiveChange(body: string): boolean {
  return /\b(?:change|replace|update) the (?:objective|instruction)\b/i.test(body);
}

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringValues);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
}

function unitsIn(text: string): Set<string> {
  return new Set([...text.matchAll(/\b(?:kg|m\/s|hz|gb|mb|bytes|mol|newton)\b/gi)].map((match) => match[0].toLowerCase()));
}

function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+/g)].map((match) => match[0]);
}

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((word) => (word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word))
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]).size;
  const intersection = intersectionCount(left, right);
  return union === 0 ? 0 : intersection / union;
}

function intersectionCount(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const word of left) {
    if (right.has(word)) {
      intersection += 1;
    }
  }
  return intersection;
}

function answered(turns: readonly CheckpointTurn[], index: number): boolean {
  const turn = turns[index];
  if (!turn) {
    return false;
  }
  return turns.slice(index + 1).some((later) => later.department !== turn.department && ["response", "evidence", "counterargument", "disagreement", "resolution", "agreement"].includes(later.kind));
}

function cite(turn: CheckpointTurn): string {
  return `message ${turn.id} ${turn.department} (${turn.kind}): ${turn.body}`;
}

function lines(value: string[]): string {
  return value.length > 0 ? value.join("\n") : "(none)";
}

function successCriteria(instruction: string): string[] {
  const sentences = instruction.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  const selected = sentences.filter((sentence) => /\b(?:plan|criterion|measure|test|evaluate|propose)\b/i.test(sentence));
  return selected.length > 0 ? selected : sentences.slice(0, 1);
}

function learningRateSymbols(text: string): Set<string> {
  const found = new Set<string>();
  if (/(?:\\theta|\u03b8|θ).{0,32}learning rate|learning rate.{0,32}(?:\\theta|\u03b8|θ)/i.test(text)) {
    found.add("theta");
  }
  if (/(?:\\eta|\u03b7|η).{0,32}learning rate|learning rate.{0,32}(?:\\eta|\u03b7|η)/i.test(text)) {
    found.add("eta");
  }
  return found;
}

function conflictingLearningRate(body: string, priorBodies: readonly string[]): boolean {
  const current = learningRateSymbols(body);
  if (current.size > 1) {
    return true;
  }
  const prior = new Set<string>();
  for (const text of priorBodies) {
    for (const symbol of learningRateSymbols(text)) {
      prior.add(symbol);
    }
  }
  if (current.size === 0 || prior.size === 0) {
    return false;
  }
  for (const symbol of current) {
    if (!prior.has(symbol)) {
      return true;
    }
  }
  return false;
}
