export type CheckpointDecision = "continue" | "invite" | "redirect" | "conclude";

export interface ConversationProgress {
  openQuestions: string[];
  agreements: string[];
  disagreements: string[];
  contributions: number;
  lastCheckpointTurn: number;
  lastDecision: CheckpointDecision | null;
}

export interface ProgressTurn {
  id: string;
  department: string;
  kind: string;
  body: string;
}

const FOLLOW_UP: Record<string, string> = {
  math: "Show the quantity and the calculation that supports it.",
  science: "State the hypothesis and what observation would change it.",
  research: "Compare sources already in the transcript. Do not invent a citation.",
  reasoning: "Name the premise and any contradiction.",
  evaluation: "Name the check and the result it would accept or reject.",
  product: "Propose one measured improvement. Do not approve it.",
  ceo: "Coordinate the next decision. Do not grant a permission.",
  orchestration: "Name the next piece of work and who should do it.",
  monitoring: "Report the limit or failure that is already visible.",
  evolution: "Propose a structural change. Do not activate a department.",
  "weight-optimization": "Describe the training evidence. Do not promote weights.",
  "memory-and-forgetting": "Note what should be retained or forgotten. Do not erase another department's memory.",
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
  };
}

export function departmentFollowUp(slug: string): string {
  const specific = FOLLOW_UP[slug] ?? "Stay inside this department's work.";
  return `${specific} Add new evidence, reasoning, a question, a calculation, or a proposal. A short agreement or a short quotation is allowed when it is not the whole turn.`;
}

export function repetitionCorrection(previousBody: string): string {
  return [
    "The previous JSON repeated a recent turn.",
    "Return one corrected JSON object.",
    "Add new evidence, reasoning, a question, a calculation, or a proposal.",
    "A short agreement or a short quotation is allowed when it is not the whole turn.",
    "Do not repeat this text:",
    previousBody.slice(0, 500),
  ].join("\n");
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
