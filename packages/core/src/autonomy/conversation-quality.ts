export type CheckpointDecision = "continue" | "invite" | "redirect" | "conclude";

export interface DepartmentContributionTally {
  contributions: number;
  disagreements: number;
  questions: number;
  evidence: number;
}

export interface ConversationProgress {
  openQuestions: string[];
  agreements: string[];
  disagreements: string[];
  contributions: number;
  lastCheckpointTurn: number;
  lastDecision: CheckpointDecision | null;
  byDepartment: Record<string, DepartmentContributionTally>;
  substantialProgress: boolean;
  progressReason: string;
  terminationReason: string | null;
  turnDecisions: string[];
  recoveryTotal: number;
  recoveryMode: RecoveryMode;
  recoverySpeakerId: string | null;
}

export type RecoveryMode = "none" | "handoff" | "synthesis";

export const MAX_CONVERSATION_RECOVERIES = 3;

export interface ProgressTurn {
  id: string;
  department: string;
  kind: string;
  body: string;
}

const FOLLOW_UP: Record<string, string> = {
  math: "State the definitions and assumptions before an equation. Show a derivation or a worked example, and mark the equation as proposed unless it is an established result.",
  science: "State a hypothesis, a falsifiable prediction, and a limitation.",
  research: "Compare sources already in the transcript. Do not invent a citation. Say when verification is pending.",
  reasoning: "Name the premise and any contradiction.",
  evaluation: "State an independent test and the acceptance criterion. An assessment does not close the conversation.",
  product: "Propose one measured improvement. Do not approve it.",
  ceo: "Coordinate the next decision. Do not grant a permission.",
  orchestration: "Name the dependency and the next concrete action.",
  monitoring: "State the compute budget, resource limit, or operational risk.",
  evolution: "Propose a structural change. Do not activate a department.",
  "weight-optimization": "Describe a training or model-update strategy and the measurement that would test it. Do not promote weights.",
  "memory-and-forgetting": "Address retention, interference, or the knowledge lifecycle. Do not erase another department's memory.",
  engineering: "State implementation feasibility and the next execution step.",
};

const EXPERTS: Array<{ slug: string; words: string[] }> = [
  { slug: "math", words: ["quantity", "equation", "calculate", "number"] },
  { slug: "research", words: ["citation", "source", "literature"] },
  { slug: "reasoning", words: ["contradiction", "premise", "logic"] },
  { slug: "science", words: ["hypothesis", "experiment"] },
];

const ASKS = new Set(["question", "challenge", "disagreement"]);
const ANSWERS = new Set(["response", "evidence", "counterargument", "disagreement", "resolution", "agreement"]);

export function emptyProgress(): ConversationProgress {
  return {
    openQuestions: [],
    agreements: [],
    disagreements: [],
    contributions: 0,
    lastCheckpointTurn: 0,
    lastDecision: null,
    byDepartment: {},
    substantialProgress: false,
    progressReason: "No deliverable has been verified.",
    terminationReason: null,
    turnDecisions: [],
    recoveryTotal: 0,
    recoveryMode: "none",
    recoverySpeakerId: null,
  };
}

export function readProgress(value: unknown): ConversationProgress {
  const empty = emptyProgress();
  if (!value || typeof value !== "object") {
    return empty;
  }
  const row = value as Partial<ConversationProgress>;
  const decision = row.lastDecision;
  return {
    openQuestions: stringList(row.openQuestions),
    agreements: stringList(row.agreements),
    disagreements: stringList(row.disagreements),
    contributions: typeof row.contributions === "number" ? row.contributions : 0,
    lastCheckpointTurn: typeof row.lastCheckpointTurn === "number" ? row.lastCheckpointTurn : 0,
    lastDecision: decision === "continue" || decision === "invite" || decision === "redirect" || decision === "conclude" ? decision : null,
    byDepartment: readDepartmentLedger(row.byDepartment),
    substantialProgress: row.substantialProgress === true,
    progressReason: typeof row.progressReason === "string" ? row.progressReason : empty.progressReason,
    terminationReason: typeof row.terminationReason === "string" ? row.terminationReason : null,
    turnDecisions: stringList(row.turnDecisions),
    recoveryTotal: typeof row.recoveryTotal === "number" ? row.recoveryTotal : 0,
    recoveryMode: row.recoveryMode === "handoff" || row.recoveryMode === "synthesis" ? row.recoveryMode : "none",
    recoverySpeakerId: typeof row.recoverySpeakerId === "string" ? row.recoverySpeakerId : null,
  };
}

export function departmentContributions(turns: readonly { department: string; kind: string }[]): Record<string, DepartmentContributionTally> {
  const ledger: Record<string, DepartmentContributionTally> = {};
  for (const turn of turns) {
    const row = ledger[turn.department] ?? { contributions: 0, disagreements: 0, questions: 0, evidence: 0 };
    if (turn.kind === "question") {
      row.questions += 1;
    }
    if (turn.kind === "disagreement" || turn.kind === "counterargument" || turn.kind === "challenge") {
      row.disagreements += 1;
    }
    if (turn.kind === "evidence") {
      row.evidence += 1;
    }
    if (turn.kind !== "close") {
      row.contributions += 1;
    }
    ledger[turn.department] = row;
  }
  return ledger;
}

function readDepartmentLedger(value: unknown): Record<string, DepartmentContributionTally> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const ledger: Record<string, DepartmentContributionTally> = {};
  for (const [slug, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const row = raw as Partial<DepartmentContributionTally>;
    ledger[slug] = {
      contributions: typeof row.contributions === "number" ? row.contributions : 0,
      disagreements: typeof row.disagreements === "number" ? row.disagreements : 0,
      questions: typeof row.questions === "number" ? row.questions : 0,
      evidence: typeof row.evidence === "number" ? row.evidence : 0,
    };
  }
  return ledger;
}

export function departmentFollowUp(slug: string): string {
  const specific = FOLLOW_UP[slug] ?? "Stay inside this department's work.";
  return `${specific} Add new evidence, reasoning, a question, a calculation, or a proposal. A short agreement or a short quotation is allowed when it is not the whole turn.`;
}

export function repetitionCorrection(previousBody: string): string {
  return [
    "The previous JSON repeated a recent turn.",
    "Return one corrected JSON object that contributes something new.",
    "Add one of these: a concrete calculation; a criticism or limitation of the previous proposal; a proposed experiment; an answer to an unresolved question; or a synthesis of findings and next actions.",
    "Do not invent evidence or citations.",
    "Do not repeat this text:",
    previousBody.slice(0, 500),
  ].join("\n");
}

export function planRecovery(input: {
  total: number;
  otherDepartmentIds: readonly string[];
}): { action: "handoff" | "synthesis" | "close"; departmentId: string | null; total: number } {
  const total = input.total + 1;
  const departmentId = input.otherDepartmentIds[0] ?? null;
  if (total > MAX_CONVERSATION_RECOVERIES || !departmentId) {
    return { action: "close", departmentId: null, total };
  }
  return { action: input.total === 0 ? "handoff" : "synthesis", departmentId, total };
}

export function recoveryInstruction(mode: RecoveryMode): string | null {
  if (mode === "none") {
    return null;
  }
  const action = mode === "synthesis"
    ? "Synthesize the findings and name the next action. Unresolved questions may remain."
    : "The previous department repeated itself. That draft was not stored.";
  return [
    action,
    "Contribute one new item: a concrete calculation, a criticism or limitation of the previous proposal, a proposed experiment, an answer to an unresolved question, or a synthesis of findings and next actions.",
    "Do not invent evidence or citations.",
  ].join(" ");
}

export function normalizeTurn(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function isNearVerbatim(body: string, recentBodies: string[]): boolean {
  const normalized = normalizeTurn(body);
  if (!normalized) {
    return false;
  }
  return recentBodies.some((previous) => {
    const other = normalizeTurn(previous);
    if (!other) {
      return false;
    }
    if (normalized === other) {
      return true;
    }
    const left = normalized.split(" ");
    const right = other.split(" ");
    if (left.length < 6 || right.length < 6) {
      return false;
    }
    return similarity(left, right) >= 0.82;
  });
}

export function permitsEcho(body: string, kind: string, recentBodies: string[]): boolean {
  if (kind === "agreement" && body.trim().length <= 400) {
    return true;
  }
  const quotes = [...body.matchAll(/"([^"]{8,180})"/g)].map((match) => match[1] ?? "");
  if (quotes.length === 0) {
    return false;
  }
  const quoted = quotes.some((quote) => recentBodies.some((turn) => turn.includes(quote)));
  const remainder = body.replace(/"[^"]*"/g, " ").replace(/\s+/g, " ").trim();
  if (!quoted || remainder.length < 40) {
    return false;
  }
  return !isNearVerbatim(remainder, recentBodies);
}

export function rollingSummary(turns: ProgressTurn[]): string {
  const older = turns.slice(0, Math.max(0, turns.length - 6));
  const lines = older.slice(-12).map((turn) => `message ${turn.id} ${turn.department} (${turn.kind}): ${turn.body.slice(0, 160)}`);
  if (lines.length === 0) {
    return turns.slice(-6).map((turn) => `message ${turn.id} ${turn.department} (${turn.kind})`).join(", ");
  }
  return `summary (not a verbatim transcript): ${lines.join(" | ")}`;
}

export function assessProgress(turns: ProgressTurn[], interval: number): {
  decision: CheckpointDecision;
  justified: boolean;
  openQuestions: string[];
  agreements: string[];
  disagreements: string[];
  contributions: number;
  inviteSlug: string | null;
  summary: string;
} {
  const openQuestions = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn || !ASKS.has(turn.kind)) {
      continue;
    }
    const answered = turns.slice(index + 1).some((later) => later.department !== turn.department && ANSWERS.has(later.kind));
    if (!answered) {
      openQuestions.push(`message ${turn.id}: ${turn.body.slice(0, 80)}`);
    }
  }
  const present = new Set(turns.map((turn) => turn.department));
  const haystack = [...openQuestions, ...turns.slice(-interval).map((turn) => turn.body)].join(" ").toLowerCase();
  const inviteSlug = EXPERTS.find((expert) => !present.has(expert.slug) && expert.words.some((word) => haystack.includes(word)))?.slug ?? null;
  const contributions = contributionCount(turns, interval);
  const decision: CheckpointDecision = contributions > 0
    ? "continue"
    : openQuestions.length > 0 && inviteSlug
      ? "invite"
      : openQuestions.length > 0
        ? "redirect"
        : "conclude";
  return {
    decision,
    justified: contributions > 0 || openQuestions.length > 0,
    openQuestions: openQuestions.slice(-8),
    agreements: clipKind(turns, "agreement"),
    disagreements: [...clipKind(turns, "disagreement"), ...clipKind(turns, "counterargument"), ...clipKind(turns, "challenge")].slice(-8),
    contributions,
    inviteSlug: decision === "invite" ? inviteSlug : null,
    summary: rollingSummary(turns),
  };
}

function contributionCount(turns: ProgressTurn[], interval: number): number {
  const start = Math.max(0, turns.length - Math.max(1, interval));
  let count = 0;
  for (let index = start; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }
    const earlier = turns.slice(0, index).map((item) => item.body);
    if (isNearVerbatim(turn.body, earlier) && !permitsEcho(turn.body, turn.kind, earlier)) {
      continue;
    }
    count += 1;
  }
  return count;
}

function clipKind(turns: ProgressTurn[], kind: string): string[] {
  return turns.filter((turn) => turn.kind === kind).slice(-8).map((turn) => `message ${turn.id}: ${turn.body.slice(0, 80)}`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(-8) : [];
}

function similarity(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  let intersection = 0;
  for (const word of new Set(left)) {
    if (rightSet.has(word)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}
