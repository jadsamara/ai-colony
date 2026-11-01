export type TokenSource = "observed" | "unavailable" | "estimated";

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  source: TokenSource;
}

export interface CostRates {
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function normalizeUsage(input: {
  promptTokens?: number | null;
  completionTokens?: number | null;
}): TokenUsage {
  const inputTokens = finiteToken(input.promptTokens);
  const outputTokens = finiteToken(input.completionTokens);
  if (inputTokens === null && outputTokens === null) {
    return { inputTokens: null, outputTokens: null, source: "unavailable" };
  }
  return { inputTokens, outputTokens, source: "observed" };
}

export function estimateCostUsdMicros(usage: TokenUsage, rates: CostRates): number | null {
  if (usage.source !== "observed" || usage.inputTokens === null || usage.outputTokens === null) {
    return null;
  }
  if (rates.inputUsdPerMillion === null || rates.outputUsdPerMillion === null) {
    return null;
  }
  const dollars =
    (usage.inputTokens / 1_000_000) * rates.inputUsdPerMillion +
    (usage.outputTokens / 1_000_000) * rates.outputUsdPerMillion;
  return Math.round(dollars * 1_000_000);
}

function finiteToken(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}
