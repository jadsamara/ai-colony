import type { MemoryStatus } from "@ai-colony/contracts";

export interface RankInput {
  id: string;
  contentHash: string;
  status: MemoryStatus;
  createdAt: string;
  vectorScore: number | null;
  keywordScore: number;
}

export interface Ranked extends RankInput {
  score: number;
  mode: "hybrid" | "keyword";
}

const TRUST: Record<MemoryStatus, number> = {
  validated: 1,
  candidate: 0.55,
  disputed: 0.25,
  superseded: 0,
  archived: 0,
  expired: 0,
  forgetting_requested: 0,
  forgotten: 0,
};

const HALF_LIFE_DAYS = 30;

/**
 * Hybrid score = 0.65 vector + 0.20 keyword + 0.10 recency + 0.05 trust.
 * Keyword-only fallback, used when embeddings are unavailable, is
 * 0.75 keyword + 0.15 recency + 0.10 trust and is labeled keyword.
 * A non-empty query with neither a vector nor a keyword match scores 0.
 * Similarity is not treated as factual correctness.
 */
export function rankMemories(items: RankInput[], now: Date, mode: "hybrid" | "keyword"): Ranked[] {
  const ranked = items.map((item) => {
    const keyword = normalizeKeyword(item.keywordScore);
    const vector = item.vectorScore === null ? null : clamp(item.vectorScore);
    const recency = Math.pow(0.5, ageDays(item.createdAt, now) / HALF_LIFE_DAYS);
    const trust = TRUST[item.status];
    const hasEvidence = (vector !== null && vector > 0) || keyword > 0;
    const score = !hasEvidence
      ? 0
      : mode === "hybrid" && vector !== null
        ? 0.65 * vector + 0.2 * keyword + 0.1 * recency + 0.05 * trust
        : 0.75 * keyword + 0.15 * recency + 0.1 * trust;
    return { ...item, score, mode: mode === "hybrid" && vector !== null ? "hybrid" as const : "keyword" as const };
  });
  ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const seen = new Set<string>();
  return ranked.filter((item) => {
    if (seen.has(item.contentHash)) {
      return false;
    }
    seen.add(item.contentHash);
    return true;
  });
}

export function fitContext<T extends { summary: string; content: string }>(
  items: T[],
  maxTokens: number,
  tokens: (text: string) => number,
): T[] {
  const chosen: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = tokens(`${item.summary}\n${item.content}`);
    if (used + cost > maxTokens) {
      continue;
    }
    chosen.push(item);
    used += cost;
  }
  return chosen;
}

function normalizeKeyword(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }
  return clamp(rank / 0.05);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function ageDays(createdAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(createdAt)) / 86_400_000);
}
