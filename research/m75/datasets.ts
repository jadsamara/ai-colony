import type { Problem } from "./arithmetic.js";
import { scoreInteger } from "./extract.js";
import { TRAIN_BUDGET } from "./protocol.js";

export interface AttemptRecord {
  item: Problem;
  attemptId: string;
  response: string;
  seed: number;
}

export interface TrainingExample {
  itemId: string;
  prompt: string;
  assistant: string;
  expected: number;
  difficultyKey: string;
  canonical: string;
  source: "programmatic" | "self_verified";
}

export interface VerifiedBuild {
  examples: TrainingExample[];
  attempts: number;
  correctAttempts: number;
  unparseableAttempts: number;
  incorrectAttempts: number;
  duplicateProblemsCollapsed: number;
}

export interface MatchResult {
  supervised: TrainingExample[];
  self: TrainingExample[];
  sufficient: boolean;
  easyDominated: boolean;
  shortfall: Record<string, number>;
  answerCapDropped: number;
}

/** Verified successes become integer targets. Raw model text is never the training target. */
export function verifiedExamples(attempts: AttemptRecord[]): VerifiedBuild {
  const byItem = new Map<string, TrainingExample>();
  let correctAttempts = 0;
  let unparseableAttempts = 0;
  let incorrectAttempts = 0;
  let duplicateProblemsCollapsed = 0;
  for (const attempt of attempts) {
    const scored = scoreInteger(attempt.response, attempt.item.expected);
    if (!scored.formatValid || scored.extracted === null) {
      unparseableAttempts += 1;
      continue;
    }
    if (!scored.correct) {
      incorrectAttempts += 1;
      continue;
    }
    correctAttempts += 1;
    if (byItem.has(attempt.item.itemId)) {
      duplicateProblemsCollapsed += 1;
      continue;
    }
    byItem.set(attempt.item.itemId, {
      itemId: attempt.item.itemId,
      prompt: attempt.item.prompt,
      assistant: String(attempt.item.expected),
      expected: attempt.item.expected,
      difficultyKey: attempt.item.difficultyKey,
      canonical: attempt.item.canonical,
      source: "self_verified",
    });
  }
  return {
    examples: [...byItem.values()].sort((left, right) => left.itemId.localeCompare(right.itemId)),
    attempts: attempts.length,
    correctAttempts,
    unparseableAttempts,
    incorrectAttempts,
    duplicateProblemsCollapsed,
  };
}

export function limitAnswerRepetition(examples: TrainingExample[], maxPerAnswer: number): { kept: TrainingExample[]; dropped: number } {
  const counts = new Map<string, number>();
  const kept: TrainingExample[] = [];
  let dropped = 0;
  for (const example of [...examples].sort((left, right) => left.itemId.localeCompare(right.itemId))) {
    const count = counts.get(example.assistant) ?? 0;
    if (count >= maxPerAnswer) {
      dropped += 1;
      continue;
    }
    counts.set(example.assistant, count + 1);
    kept.push(example);
  }
  return { kept, dropped };
}

export function matchSupervised(verified: TrainingExample[], pool: Problem[]): MatchResult {
  const capped = limitAnswerRepetition(verified, TRAIN_BUDGET.maxAnswerRepetition);
  const self = capEasyShare(capped.kept);
  const buckets = new Map<string, Problem[]>();
  for (const problem of pool) {
    const list = buckets.get(problem.difficultyKey) ?? [];
    list.push(problem);
    buckets.set(problem.difficultyKey, list);
  }
  const supervised: TrainingExample[] = [];
  const keptSelf: TrainingExample[] = [];
  const shortfall: Record<string, number> = {};
  const used = new Set<string>();
  for (const example of self) {
    const available = (buckets.get(example.difficultyKey) ?? []).filter((problem) => !used.has(problem.itemId));
    const match = available[0];
    if (match === undefined) {
      shortfall[example.difficultyKey] = (shortfall[example.difficultyKey] ?? 0) + 1;
      continue;
    }
    used.add(match.itemId);
    keptSelf.push(example);
    supervised.push({
      itemId: match.itemId,
      prompt: match.prompt,
      assistant: String(match.expected),
      expected: match.expected,
      difficultyKey: match.difficultyKey,
      canonical: match.canonical,
      source: "programmatic",
    });
  }
  const easy = self.filter((example) => example.difficultyKey.startsWith("2|") || example.difficultyKey.includes("|1-20")).length;
  return {
    supervised,
    self: keptSelf,
    sufficient: keptSelf.length >= TRAIN_BUDGET.minVerifiedExamples && supervised.length === keptSelf.length,
    easyDominated: self.length > 0 && easy / self.length > TRAIN_BUDGET.maxEasyShare,
    shortfall,
    answerCapDropped: capped.dropped,
  };
}

function capEasyShare(examples: TrainingExample[]): TrainingExample[] {
  const easy = examples.filter((example) => example.difficultyKey.includes("|1-20"));
  const other = examples.filter((example) => !example.difficultyKey.includes("|1-20"));
  if (other.length === 0 || examples.length < TRAIN_BUDGET.minVerifiedExamples) {
    return examples;
  }
  const maxEasy = Math.floor((TRAIN_BUDGET.maxEasyShare / (1 - TRAIN_BUDGET.maxEasyShare)) * other.length);
  if (easy.length <= maxEasy) {
    return examples;
  }
  const keptEasy = [...easy].sort((left, right) => left.itemId.localeCompare(right.itemId)).slice(0, maxEasy);
  const capped = [...keptEasy, ...other];
  return capped.length >= TRAIN_BUDGET.minVerifiedExamples ? capped : examples;
}

export function programmaticExamples(problems: Problem[]): TrainingExample[] {
  return problems.map((problem) => ({
    itemId: problem.itemId,
    prompt: problem.prompt,
    assistant: String(problem.expected),
    expected: problem.expected,
    difficultyKey: problem.difficultyKey,
    canonical: problem.canonical,
    source: "programmatic" as const,
  }));
}

export function assertNoCanonicalLeak(trainCanonicals: string[], forbidden: string[]): void {
  const blocked = new Set(forbidden);
  for (const canonical of trainCanonicals) {
    if (blocked.has(canonical)) {
      throw new Error(`training data contains held-out expression ${canonical}`);
    }
  }
}

export function toChatLine(example: TrainingExample): string {
  return JSON.stringify({
    messages: [
      { role: "user", content: example.prompt },
      { role: "assistant", content: example.assistant },
    ],
    itemId: example.itemId,
    source: example.source,
    expected: example.expected,
  });
}
