import { deterministicEmbedding, type EmbeddingProvider, type EmbeddingVector } from "@ai-colony/core";

export class ScriptedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly model = "scripted-embed",
    private readonly dimensions = 768,
  ) {}

  getModelInfo(): { model: string; dimensions: number } {
    return { model: this.model, dimensions: this.dimensions };
  }

  async embedText(text: string): Promise<EmbeddingVector> {
    return {
      model: this.model,
      dimensions: this.dimensions,
      values: deterministicEmbedding(text, this.dimensions),
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    return Promise.all(texts.map((text) => this.embedText(text)));
  }

  async healthCheck(): Promise<{ ok: boolean; model: string | null; dimensions: number | null; error: string | null }> {
    return { ok: true, model: this.model, dimensions: this.dimensions, error: null };
  }
}
