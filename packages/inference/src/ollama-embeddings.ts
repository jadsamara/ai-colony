import { assertFiniteVector, EmbeddingError, type EmbeddingProvider, type EmbeddingVector } from "@ai-colony/core";

export interface OllamaEmbeddingOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  maxConcurrency: number;
  transportRetries: number;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly options: OllamaEmbeddingOptions) {}

  getModelInfo(): { model: string; dimensions: number } {
    return { model: this.options.model, dimensions: this.options.dimensions };
  }

  async embedText(text: string, signal?: AbortSignal): Promise<EmbeddingVector> {
    const [vector] = await this.embedBatch([text], signal);
    if (!vector) {
      throw new EmbeddingError("bad_vector", "Embedding response did not include a vector", false);
    }
    return vector;
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingVector[]> {
    if (texts.length === 0) {
      return [];
    }
    return this.limit(() => this.send(texts, signal));
  }

  async healthCheck(): Promise<{ ok: boolean; model: string | null; dimensions: number | null; error: string | null }> {
    try {
      const vector = await this.embedText("ping");
      return { ok: true, model: vector.model, dimensions: vector.dimensions, error: null };
    } catch (error) {
      return { ok: false, model: null, dimensions: null, error: error instanceof Error ? error.message : "Embedding unavailable" };
    }
  }

  private async send(texts: string[], signal?: AbortSignal): Promise<EmbeddingVector[]> {
    let lastError: EmbeddingError | null = null;
    for (let attempt = 0; attempt <= this.options.transportRetries; attempt += 1) {
      try {
        const response = await fetch(this.endpoint("/api/embed"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.options.model, input: texts }),
          signal: this.signal(signal),
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new EmbeddingError("transport", `Embedding server returned ${response.status}`, true);
          continue;
        }
        if (!response.ok) {
          throw new EmbeddingError("bad_vector", `Embedding server returned ${response.status}`, false);
        }
        const body = (await response.json()) as { model?: string; embeddings?: number[][] };
        if (body.model !== this.options.model || !Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
          throw new EmbeddingError(
            "identity_mismatch",
            `Embedding server model ${body.model ?? "unknown"} did not match ${this.options.model}`,
            false,
          );
        }
        return body.embeddings.map((values) => {
          assertFiniteVector(values, this.options.dimensions);
          return { model: body.model ?? this.options.model, dimensions: values.length, values };
        });
      } catch (error) {
        if (error instanceof EmbeddingError) {
          if (!error.retryable) {
            throw error;
          }
          lastError = error;
          continue;
        }
        if (signal?.aborted) {
          throw new EmbeddingError("unavailable", "Embedding was cancelled", false);
        }
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new EmbeddingError("timeout", "Embedding timed out", true);
        }
        lastError = new EmbeddingError("unavailable", error instanceof Error ? error.message : "Embedding unavailable", true);
      }
    }
    throw lastError ?? new EmbeddingError("unavailable", "Embedding unavailable", true);
  }

  private endpoint(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    if (!signal) {
      return timeout;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted || timeout.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
    return controller.signal;
  }

  private async limit<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.options.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
