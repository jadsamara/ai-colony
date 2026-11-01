import type { TokenUsage } from "./usage.js";

export type InferencePurpose = "plan" | "correct" | "specialist" | "synthesize" | "monitor";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface InferenceRequest {
  requestId: string;
  registryModelId: string;
  modelAlias: string;
  messages: ChatMessage[];
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  jsonObject: boolean;
  signal?: AbortSignal;
}

export interface InferenceResult {
  text: string;
  servedModel: string;
  usage: TokenUsage;
  latencyMs: number;
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
