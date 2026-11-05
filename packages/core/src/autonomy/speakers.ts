export interface SpeakerCandidate {
  id: string;
  slug: string;
  name: string;
}

export interface SpeakerTurn {
  departmentId: string;
  departmentSlug: string;
  kind: string;
  body: string;
  addressedDepartmentId: string | null;
}

export type SpeakerReason = "directed" | "unanswered" | "expertise" | "not_yet_spoken" | "least_recent";

export interface SpeakerChoice {
  departmentId: string;
  slug: string;
  reason: SpeakerReason;
}

const EXPERTISE: Record<string, readonly string[]> = {
  math: ["math", "mathematical", "quantity", "equation", "proof", "calculate"],
  science: ["science", "physics", "experiment", "hypothesis"],
  research: ["research", "evidence", "citation", "literature", "source"],
  reasoning: ["reasoning", "contradiction", "argument", "logic", "premise"],
  product: ["product", "user", "improvement"],
  evaluation: ["evaluation", "benchmark", "metric"],
  monitoring: ["monitor", "health", "latency"],
  "memory-and-forgetting": ["memory", "forgetting", "retention"],
  evolution: ["evolution", "structure"],
  "weight-optimization": ["weight", "quantization", "adapter"],
  ceo: ["goal", "priority", "strategy"],
  orchestration: ["schedule", "workflow", "task"],
};

const ANSWER_KINDS = new Set(["response", "evidence", "counterargument", "disagreement", "resolution"]);

export function maySpeak(input: {
  departmentId: string;
  participantIds: readonly string[];
  turns: readonly SpeakerTurn[];
}): { allowed: boolean; reason: string } {
  const others = input.participantIds.filter((id) => id !== input.departmentId);
  if (others.length === 0) {
    return { allowed: false, reason: "A conversation needs another active department" };
  }
  if (input.turns.length === 0) {
    return { allowed: true, reason: "opening" };
  }
  const last = input.turns[input.turns.length - 1];
  if (!last) {
    return { allowed: true, reason: "opening" };
  }
  const directed = last.addressedDepartmentId === input.departmentId && last.departmentId !== input.departmentId;
  if (directed) {
    return { allowed: true, reason: "directed" };
  }
  const counts = new Map<string, number>(input.participantIds.map((id) => [id, 0]));
  for (const turn of input.turns) {
    counts.set(turn.departmentId, (counts.get(turn.departmentId) ?? 0) + 1);
  }
  const mine = counts.get(input.departmentId) ?? 0;
  const otherMin = Math.min(...others.map((id) => counts.get(id) ?? 0));
  if (last.departmentId === input.departmentId && mine > otherMin) {
    return { allowed: false, reason: "The last speaker must let another department speak" };
  }
  if (input.participantIds.length >= 3 && mine >= otherMin + 2) {
    return { allowed: false, reason: "This department has spoken too often for the current group" };
  }
  return { allowed: true, reason: "scheduled" };
}

export function selectSpeaker(input: {
  participants: readonly SpeakerCandidate[];
  turns: readonly SpeakerTurn[];
  topic: string;
  remainingMessages: number;
}): SpeakerChoice | null {
  if (input.participants.length < 2 || input.remainingMessages <= 0) {
    return null;
  }
  const last = input.turns[input.turns.length - 1] ?? null;
  let best: SpeakerChoice & { score: number } | null = null;
  for (const participant of input.participants) {
    const decision = maySpeak({
      departmentId: participant.id,
      participantIds: input.participants.map((item) => item.id),
      turns: input.turns,
    });
    if (!decision.allowed) {
      continue;
    }
    const spoken = input.turns.filter((turn) => turn.departmentId === participant.id).length;
    let score = -spoken * 5;
    let reason: SpeakerReason = spoken === 0 ? "not_yet_spoken" : "least_recent";
    if (spoken === 0) {
      score += 25;
    }
    const latestText = last?.body ?? "";
    if (expertiseHit(participant.slug, latestText) || (spoken === 0 && expertiseHit(participant.slug, input.topic))) {
      score += 40;
      reason = "expertise";
    }
    if (hasUnanswered(input.turns, participant)) {
      score += 35;
      reason = "unanswered";
    }
    if (isDirected(last, participant)) {
      score += 100;
      reason = "directed";
    }
    if (last?.departmentId === participant.id) {
      score -= 50;
    }
    if (!best || score > best.score || (score === best.score && participant.slug < best.slug)) {
      best = { departmentId: participant.id, slug: participant.slug, reason, score };
    }
  }
  if (!best) {
    return null;
  }
  return { departmentId: best.departmentId, slug: best.slug, reason: best.reason };
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function buildDialogueContext<T extends { department: string; kind: string; body: string; id?: string }>(
  turns: readonly T[],
  tokenBudget = 1_500,
): { summary: string | null; verbatim: T[]; tokens: number } {
  const verbatim: T[] = [];
  let tokens = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }
    const cost = estimateTokens(`${turn.id ?? ""} ${turn.department} (${turn.kind}): ${turn.body}`);
    if (verbatim.length > 0 && tokens + cost > tokenBudget) {
      break;
    }
    verbatim.push(turn);
    tokens += cost;
  }
  verbatim.reverse();
  const older = turns.slice(0, turns.length - verbatim.length);
  const summary = older.length
    ? `summary (not a verbatim transcript): ${older
        .map((turn) => `message ${turn.id ?? "unspecified"} ${turn.department} (${turn.kind}): ${clip(turn.body, 160)}`)
        .join(" | ")}`
    : null;
  return { summary, verbatim, tokens };
}

function isDirected(last: SpeakerTurn | null, participant: SpeakerCandidate): boolean {
  if (!last || last.departmentId === participant.id) {
    return false;
  }
  if (last.addressedDepartmentId === participant.id) {
    return true;
  }
  return last.addressedDepartmentId === null && mentions(last.body, participant);
}

function hasUnanswered(turns: readonly SpeakerTurn[], participant: SpeakerCandidate): boolean {
  return turns.some((turn, index) => {
    const asks = turn.kind === "question" || turn.kind === "challenge" || turn.kind === "disagreement";
    const targets = turn.addressedDepartmentId === participant.id || (turn.addressedDepartmentId === null && mentions(turn.body, participant));
    if (!asks || !targets || turn.departmentId === participant.id) {
      return false;
    }
    return !turns.slice(index + 1).some((later) => later.departmentId === participant.id && ANSWER_KINDS.has(later.kind));
  });
}

function expertiseHit(slug: string, haystack: string): boolean {
  return (EXPERTISE[slug] ?? []).some((word) => new RegExp(`\\b${word}\\b`, "i").test(haystack));
}

function mentions(text: string, participant: SpeakerCandidate): boolean {
  const slug = participant.slug.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]");
  if (new RegExp(`\\b${slug}\\b`, "i").test(text)) {
    return true;
  }
  return text.toLowerCase().includes(participant.name.toLowerCase());
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
