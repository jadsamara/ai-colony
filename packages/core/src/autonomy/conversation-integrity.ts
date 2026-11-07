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
  status: "none" | "proposed" | "flagged";
  reasons: string[];
}

export function reviewMathClaim(body: string): MathReview {
  const equation = /[=∇]|\\frac|\\nabla|\\theta|\bpartial\b/i.test(body);
  if (!equation) {
    return { status: "none", reasons: [] };
  }
  const reasons: string[] = [];
  if (!/\b(?:assume|assumption|define|definition|let|where)\b/i.test(body)) {
    reasons.push("missing_assumptions");
  }
  if (!/\b(?:because|therefore|derive|derivation|example|worked)\b/i.test(body)) {
    reasons.push("missing_derivation");
  }
  const sides = body.split("=").map((side) => unitsIn(side));
  if (sides.length === 2 && sides[0]?.size && sides[1]?.size && [...sides[0]].every((unit) => !sides[1]?.has(unit))) {
    reasons.push("dimensional_mismatch");
  }
  return { status: reasons.length > 0 ? "flagged" : "proposed", reasons };
}

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "what", "which", "how", "is", "are", "was", "this", "that", "for", "with", "we", "our", "does", "do", "can", "without", "from", "into", "on", "in", "it", "be"]);

export function repetitionVerdict(
  body: string,
  prior: readonly { kind: string; body: string }[],
): { duplicate: boolean; novel: boolean; reason: string } {
  const current = contentWords(body);
  const novelMarker = /\bobserved:\b|\bexperiment:\b|\bdoi:\b|\bsource:\b|\d/.test(body);
  for (const turn of prior) {
    const previous = contentWords(turn.body);
    const overlap = jaccard(current, previous);
    const fresh = [...current].filter((word) => !previous.has(word));
    const bothQuestions = /\?/.test(body) && /\?/.test(turn.body);
    const sameQuestion = bothQuestions && intersectionCount(current, previous) >= 4 && fresh.length < 3 && !novelMarker;
    if ((overlap >= 0.72 && fresh.length < 2 && !novelMarker) || sameQuestion) {
      return { duplicate: true, novel: false, reason: "The turn repeats an earlier question or claim without new evidence." };
    }
    if (overlap >= 0.5 && (fresh.length >= 2 || novelMarker)) {
      return { duplicate: false, novel: true, reason: "The turn revisits an earlier point with new evidence or terms." };
    }
  }
  return { duplicate: false, novel: current.size > 0, reason: "The turn adds a distinct contribution." };
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

function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word)));
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
