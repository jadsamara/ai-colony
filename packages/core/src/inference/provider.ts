import type { TokenUsage } from "./usage.js";

export type InferencePurpose =
  | "plan"
  | "correct"
  | "specialist"
  | "synthesize"
  | "monitor"
  | "routing"
  | "join_approval";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export type ThinkingPreference = "disabled" | "enabled" | "default";

export interface InferenceRequest {
  requestId: string;
  registryModelId: string;
  modelAlias: string;
  messages: ChatMessage[];
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  jsonObject: boolean;
  /**
   * When set with jsonObject, providers that support it should request
   * response_format json_schema (Ollama grammar). Callers still validate.
   */
  jsonSchema?: Record<string, unknown> | null;
  /**
   * Per-request thinking preference. Overrides provider defaults when set.
   * disabled → explicitly turn thinking off; enabled → explicitly turn it on.
   */
  thinking?: ThinkingPreference | null;
  signal?: AbortSignal;
}

export interface InferenceResult {
  text: string;
  servedModel: string;
  servedDigest?: string | null;
  usage: TokenUsage;
  latencyMs: number;
  /** OpenAI/Ollama finish reason when present (e.g. stop, length). */
  finishReason?: string | null;
  /** True when finish_reason is length or the provider marked truncation. */
  truncated?: boolean;
  /**
   * True when the server returned a separate reasoning/thinking trace.
   * Reasoning text is never copied into `text` and must not be scored as an answer.
   */
  reasoningPresent?: boolean;
}

export interface ModelProbe {
  reachable: boolean;
  modelIds: string[];
  error: string | null;
}

export interface InferenceProvider {
  generate(request: InferenceRequest): Promise<InferenceResult>;
  probe(): Promise<ModelProbe>;
}

export class InferenceError extends Error {
  readonly code: "timeout" | "cancelled" | "unavailable" | "identity_mismatch" | "transport" | "bad_response";
  readonly retryable: boolean;

  constructor(
    code: InferenceError["code"],
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "InferenceError";
    this.code = code;
    this.retryable = retryable;
  }
}
