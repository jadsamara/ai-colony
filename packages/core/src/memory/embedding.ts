export class EmbeddingError extends Error {
  readonly code: "timeout" | "unavailable" | "identity_mismatch" | "bad_vector" | "transport";
  readonly retryable: boolean;

  constructor(
    code: EmbeddingError["code"],
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface EmbeddingVector {
  model: string;
  dimensions: number;
  values: number[];
}

export interface EmbeddingProvider {
  embedText(text: string, signal?: AbortSignal): Promise<EmbeddingVector>;
  embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingVector[]>;
  getModelInfo(): { model: string; dimensions: number };
  healthCheck(): Promise<{ ok: boolean; model: string | null; dimensions: number | null; error: string | null }>;
}

export function assertFiniteVector(values: number[], dimensions: number): void {
  if (values.length !== dimensions || values.some((value) => !Number.isFinite(value))) {
    throw new EmbeddingError("bad_vector", `Expected ${dimensions} finite embedding values`, false);
  }
}

export function deterministicEmbedding(text: string, dimensions: number): number[] {
  const values = new Array<number>(dimensions).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 0)) {
    let hash = 0;
    for (const char of token) {
      hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
    }
    const bucket = hash % dimensions;
    values[bucket] = (values[bucket] ?? 0) + 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}
