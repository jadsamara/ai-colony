import { describe, expect, it } from "vitest";
import { OllamaEmbeddingProvider, loadInferenceConfig } from "@ai-colony/inference";

const enabled = process.env.RUN_REAL_EMBEDDING === "1";

describe("real Ollama embeddings", () => {
  it("returns a finite vector from the configured embedding model", async (context) => {
    if (!enabled) {
      context.skip();
      return;
    }
    const config = loadInferenceConfig(process.env);
    const provider = new OllamaEmbeddingProvider({
      baseUrl: config.embeddingBaseUrl,
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
      timeoutMs: config.embeddingTimeoutMs,
      maxConcurrency: 1,
      transportRetries: 0,
    });
    const vector = await provider.embedText("remote research station energy");
    expect(vector.model).toBe(config.embeddingModel);
    expect(vector.dimensions).toBe(config.embeddingDimensions);
    expect(vector.values).toHaveLength(config.embeddingDimensions);
    expect(vector.values.every((value) => Number.isFinite(value))).toBe(true);
  });
});