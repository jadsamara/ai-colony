import { InferenceError, type InferenceProvider, type InferenceRequest, type InferenceResult, type ModelProbe } from "@ai-colony/core";

export class ScriptedInferenceProvider implements InferenceProvider {
  readonly requests: InferenceRequest[] = [];

  constructor(
    private readonly respond: (request: InferenceRequest) => InferenceResult,
    private readonly models: string[] = ["qwen3-8b"],
  ) {}

  async generate(request: InferenceRequest): Promise<InferenceResult> {
    if (request.signal?.aborted) {
      throw new InferenceError("cancelled", "Inference was cancelled", false);
    }
    this.requests.push(request);
    return this.respond(request);
  }

  async probe(): Promise<ModelProbe> {
    return { reachable: true, modelIds: this.models, error: null };
  }
}
