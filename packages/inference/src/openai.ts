import {
  InferenceError,
  normalizeUsage,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelProbe,
  type ThinkingPreference,
} from "@ai-colony/core";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string | null;
  maxConcurrency: number;
  transportRetries: number;
  /**
   * Explicit thinking preference for Qwen3 / Ollama.
   * Prefer this over reasoningEffort. Verified on Ollama 0.40.x:
   * - disabled: `reasoning_effort: "none"` (OpenAI) or native `think: false`
   * - enabled: native/OpenAI `think: true` (do not rely on omitting controls alone)
   * OpenAI `think: false` is NOT reliable on /v1/chat/completions for Qwen3.
   */
  thinking?: ThinkingPreference;
  /**
   * @deprecated Prefer `thinking`. "none" → disabled; null → default (model decides).
   */
  reasoningEffort?: "none" | null;
}

type FormatMode = "json_schema" | "json_object" | "none";
type TransportKind = "openai" | "native";

interface PayloadVariant {
  transport: TransportKind;
  body: Record<string, unknown>;
}

export class OpenAICompatibleProvider implements InferenceProvider {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly thinking: ThinkingPreference;

  constructor(private readonly options: OpenAICompatibleOptions) {
    if (options.thinking) {
      this.thinking = options.thinking;
    } else if (options.reasoningEffort === null) {
      this.thinking = "default";
    } else {
      // Historical default: disable Qwen3 thinking so content holds the answer.
      this.thinking = "disabled";
    }
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

  /** Inspect Ollama /api/show thinking metadata when available. */
  async inspectThinking(modelAlias: string): Promise<{ values: unknown[]; default: unknown } | null> {
    try {
      const response = await fetch(this.endpoint("/api/show"), {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ model: modelAlias }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { thinking?: { values?: unknown[]; default?: unknown } };
      if (!body.thinking || !Array.isArray(body.thinking.values)) {
        return null;
      }
      return { values: body.thinking.values, default: body.thinking.default };
    } catch {
      return null;
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
          const path = payload.transport === "native" ? "/api/chat" : "/v1/chat/completions";
          const response = await fetch(this.endpoint(path), {
            method: "POST",
            headers: { ...this.headers(), "content-type": "application/json" },
            body: JSON.stringify(payload.body),
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
          return payload.transport === "native"
            ? this.readNative(request, response, started)
            : this.readOpenAI(request, response, started);
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

  private async readOpenAI(request: InferenceRequest, response: Response, started: number): Promise<InferenceResult> {
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
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string | null;
          reasoning?: string | null;
          reasoning_content?: string | null;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (!body.model || !Array.isArray(body.choices) || body.choices.length < 1) {
      throw new InferenceError("bad_response", "Inference response did not include model identity and choices", false);
    }
    if (body.model !== request.modelAlias) {
      throw new InferenceError(
        "identity_mismatch",
        `Server model ${body.model} did not match requested alias ${request.modelAlias}`,
        false,
      );
    }
    const choice = body.choices[0]!;
    const message = choice.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";
    const reasoningRaw =
      (typeof message.reasoning === "string" && message.reasoning)
      || (typeof message.reasoning_content === "string" && message.reasoning_content)
      || "";
    const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    const truncated = finishReason === "length";
    // Never promote reasoning into the scored answer text.
    const text = content.trim();
    if (!text && !truncated && reasoningRaw.trim().length === 0 && finishReason !== "stop") {
      throw new InferenceError("bad_response", "Inference response did not include model text", false);
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
      finishReason,
      truncated,
      reasoningPresent: reasoningRaw.trim().length > 0,
    };
  }

  private async readNative(request: InferenceRequest, response: Response, started: number): Promise<InferenceResult> {
    if (!response.ok) {
      throw new InferenceError(
        response.status >= 500 ? "unavailable" : "bad_response",
        `Inference server returned ${response.status}`,
        response.status >= 500,
      );
    }
    const body = (await response.json()) as {
      model?: string;
      message?: { content?: string | null; thinking?: string | null };
      done_reason?: string | null;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    if (!body.model) {
      throw new InferenceError("bad_response", "Inference response did not include model identity", false);
    }
    if (body.model !== request.modelAlias) {
      throw new InferenceError(
        "identity_mismatch",
        `Server model ${body.model} did not match requested alias ${request.modelAlias}`,
        false,
      );
    }
    const content = typeof body.message?.content === "string" ? body.message.content : "";
    const thinking = typeof body.message?.thinking === "string" ? body.message.thinking : "";
    const finishReason = typeof body.done_reason === "string" ? body.done_reason : null;
    const truncated = finishReason === "length";
    const text = content.trim();
    if (!text && !truncated && thinking.trim().length === 0 && finishReason !== "stop") {
      throw new InferenceError("bad_response", "Inference response did not include model text", false);
    }
    return {
      text,
      servedModel: body.model,
      servedDigest: null,
      usage: normalizeUsage({
        promptTokens: body.prompt_eval_count,
        completionTokens: body.eval_count,
      }),
      latencyMs: Date.now() - started,
      finishReason,
      truncated,
      reasoningPresent: thinking.trim().length > 0,
    };
  }

  private payloads(request: InferenceRequest): PayloadVariant[] {
    const thinking = request.thinking ?? this.thinking;
    const formats = this.formatModes(request);
    const seen = new Set<string>();
    const out: PayloadVariant[] = [];
    const push = (variant: PayloadVariant) => {
      const key = `${variant.transport}:${JSON.stringify(variant.body)}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push(variant);
    };

    for (const format of formats) {
      for (const control of this.thinkingControls(thinking)) {
        if (control.transport === "openai") {
          push({
            transport: "openai",
            body: this.openAiBody(request, format, control.fields),
          });
        } else if (format === "none") {
          // Native chat has no OpenAI response_format; only use it for plain text.
          push({
            transport: "native",
            body: this.nativeBody(request, control.think),
          });
        }
      }
    }
    return out;
  }

  private formatModes(request: InferenceRequest): FormatMode[] {
    if (request.jsonObject && request.jsonSchema) {
      return ["json_schema", "json_object", "none"];
    }
    if (request.jsonObject) {
      return ["json_object", "none"];
    }
    return ["none"];
  }

  /**
   * Ordered thinking-control variants.
   * Disabled must never fall back to an uncontrolled OpenAI call (that re-enables Qwen3 thinking).
   */
  private thinkingControls(
    thinking: ThinkingPreference,
  ): Array<{ transport: TransportKind; fields: Record<string, unknown>; think: boolean | null }> {
    if (thinking === "disabled") {
      return [
        { transport: "openai", fields: { reasoning_effort: "none" }, think: false },
        { transport: "openai", fields: { reasoning: { effort: "none" } }, think: false },
        { transport: "native", fields: {}, think: false },
      ];
    }
    if (thinking === "enabled") {
      return [
        { transport: "native", fields: {}, think: true },
        { transport: "openai", fields: { think: true }, think: true },
        // Last resort: omit controls (Qwen3 default is thinking on).
        { transport: "openai", fields: {}, think: null },
      ];
    }
    return [{ transport: "openai", fields: {}, think: null }];
  }

  private openAiBody(request: InferenceRequest, format: FormatMode, thinkingFields: Record<string, unknown>) {
    return {
      model: request.modelAlias,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      ...thinkingFields,
      ...(format === "json_schema" && request.jsonSchema
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: "colony_decision",
                strict: true,
                schema: request.jsonSchema,
              },
            },
          }
        : format === "json_object"
          ? { response_format: { type: "json_object" as const } }
          : {}),
    };
  }

  private nativeBody(request: InferenceRequest, think: boolean | null) {
    return {
      model: request.modelAlias,
      stream: false,
      messages: request.messages,
      options: {
        temperature: request.temperature,
        num_predict: request.maxOutputTokens,
      },
      ...(think === null ? {} : { think }),
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
