import { InferenceError, normalizeUsage, type InferenceProvider, type InferenceRequest, type InferenceResult, type ModelProbe } from "@ai-colony/core";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string | null;
  maxConcurrency: number;
  transportRetries: number;
  /**
   * Ollama's OpenAI endpoint ignores `think` and enables Qwen3 thinking unless
   * `reasoning_effort` is `none`. A server that rejects the field is retried
   * without it. Pass null to omit the field on the first request.
   */
  reasoningEffort?: "none" | null;
}

export class OpenAICompatibleProvider implements InferenceProvider {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly reasoningEffort: "none" | null;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.reasoningEffort = options.reasoningEffort === undefined ? "none" : options.reasoningEffort;
  }

  async generate(request: InferenceRequest): Promise<InferenceResult> {
    return this.limit(() => this.send(request));
  }

  async probe(): Promise<ModelProbe> {
    try {
      const response = await fetch(this.endpoint("/v1/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { reachable: false, modelIds: [], error: `Probe returned ${response.status}` };
      }
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const modelIds = (body.data ?? []).flatMap((model) => (model.id ? [model.id] : []));
      return { reachable: true, modelIds, error: null };
    } catch (error) {
      return { reachable: false, modelIds: [], error: error instanceof Error ? error.message : "Probe failed" };
    }
  }

  private async send(request: InferenceRequest): Promise<InferenceResult> {
    const started = Date.now();
    const payloads = this.payloads(request);
    let lastError: InferenceError | null = null;
    for (let attempt = 0; attempt <= this.options.transportRetries; attempt += 1) {
      let retryTransport = false;
      for (const payload of payloads) {
        try {
          const response = await fetch(this.endpoint("/v1/chat/completions"), {
            method: "POST",
            headers: { ...this.headers(), "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: this.signal(request),
          });
          if (response.status === 400) {
            lastError = new InferenceError("bad_response", "Inference server returned 400", false);
            continue;
          }
          if (response.status === 429 || response.status >= 500) {
            lastError = new InferenceError("transport", `Inference server returned ${response.status}`, true);
            retryTransport = true;
            break;
          }
          return this.read(request, response, started);
        } catch (error) {
          if (request.signal?.aborted) {
            throw new InferenceError("cancelled", "Inference was cancelled", false);
          }
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new InferenceError("timeout", "Inference timed out", true);
          }
          lastError = new InferenceError(
            "unavailable",
            error instanceof Error ? error.message : "Inference unavailable",
            true,
          );
          retryTransport = true;
          break;
        }
      }
      if (!retryTransport) {
        break;
      }
    }
    throw lastError ?? new InferenceError("unavailable", "Inference unavailable", true);
  }

  private async read(request: InferenceRequest, response: Response, started: number): Promise<InferenceResult> {
    if (!response.ok) {
      throw new InferenceError(
        response.status >= 500 ? "unavailable" : "bad_response",
        `Inference server returned ${response.status}`,
        response.status >= 500,
      );
    }
    const body = (await response.json()) as {
      model?: string;
      digest?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!body.model || !text) {
      throw new InferenceError("bad_response", "Inference response did not include model identity and text", false);
    }
    if (body.model !== request.modelAlias) {
      throw new InferenceError(
        "identity_mismatch",
        `Server model ${body.model} did not match requested alias ${request.modelAlias}`,
        false,
      );
    }
    return {
      text,
      servedModel: body.model,
      servedDigest: typeof body.digest === "string" ? body.digest : null,
      usage: normalizeUsage({
        promptTokens: body.usage?.prompt_tokens,
        completionTokens: body.usage?.completion_tokens,
      }),
      latencyMs: Date.now() - started,
    };
  }

  private payloads(request: InferenceRequest): Array<Record<string, unknown>> {
    const variants: Array<[boolean, boolean]> = [[this.reasoningEffort !== null, request.jsonObject]];
    if (this.reasoningEffort !== null) {
      variants.push([false, request.jsonObject]);
    }
    if (request.jsonObject) {
      variants.push([false, false]);
    }
    const seen = new Set<string>();
    return variants.flatMap(([reasoning, jsonObject]) => {
      const payload = this.body(request, jsonObject, reasoning);
      const key = JSON.stringify(payload);
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [payload];
    });
  }

  private body(request: InferenceRequest, jsonObject: boolean, reasoning: boolean) {
    return {
      model: request.modelAlias,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      ...(reasoning ? { reasoning_effort: "none" as const } : {}),
      ...(jsonObject ? { response_format: { type: "json_object" as const } } : {}),
    };
  }

  private headers(): Record<string, string> {
    return this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
  }

  private endpoint(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private signal(request: InferenceRequest): AbortSignal {
    const timeout = AbortSignal.timeout(request.timeoutMs);
    if (!request.signal) {
      return timeout;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (request.signal.aborted || timeout.aborted) {
      controller.abort();
      return controller.signal;
    }
    request.signal.addEventListener("abort", abort, { once: true });
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
