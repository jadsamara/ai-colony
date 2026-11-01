import { describe, expect, it } from "vitest";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import { loadInferenceConfig } from "@ai-colony/inference";
import { OpenAICompatibleProvider } from "@ai-colony/inference";

const enabled = process.env.RUN_REAL_INFERENCE === "1";

describe("real local model", () => {
  it("generates a non-empty answer from the configured model identity", async (context) => {
    if (!enabled) {
      context.skip();
      return;
    }
    const config = loadInferenceConfig(process.env);
    const provider = new OpenAICompatibleProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      maxConcurrency: 1,
      transportRetries: 0,
    });
    const probe = await provider.probe();
    expect(probe.reachable).toBe(true);
    expect(probe.modelIds).toContain(config.alias);
    const result = await provider.generate({
      requestId: "smoke",
      registryModelId: QWEN3_8B_MODEL_ID,
      modelAlias: config.alias,
      messages: [
        { role: "system", content: "Answer in one sentence." },
        { role: "user", content: "Name one engineering difference between solar and wind power." },
      ],
      temperature: config.temperature,
      maxOutputTokens: 128,
      timeoutMs: config.timeoutMs,
      jsonObject: false,
    });
    expect(result.servedModel).toBe(config.alias);
    expect(result.text.trim().length).toBeGreaterThan(20);
  });
});
