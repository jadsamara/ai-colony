import { z } from "zod";

const schema = z.object({
  INFERENCE_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  INFERENCE_API_KEY: z.string().min(1).optional(),
  INFERENCE_MODEL_ALIAS: z.string().min(1).default("qwen3:8b"),
  INFERENCE_OPERATIONAL_BASE_URL: z.string().url().optional(),
  INFERENCE_OPERATIONAL_ALIAS: z.string().min(1).optional(),
  INFERENCE_MEMORY_PROFILE: z.enum(["shared", "split"]).default("shared"),
  INFERENCE_CONTEXT_WINDOW: z.coerce.number().int().positive().max(32768).default(8192),
  INFERENCE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4096).default(1024),
  INFERENCE_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  INFERENCE_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(120_000),
  INFERENCE_MAX_CONCURRENCY: z.coerce.number().int().positive().max(2).default(1),
  INFERENCE_TRANSPORT_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  OLLAMA_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().max(10_000).default(3_000),
  OLLAMA_PROBE_FRESHNESS_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  OLLAMA_PROBE_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().max(600_000).default(10_000),
  INFERENCE_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().optional(),
  INFERENCE_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().optional(),
  OBJECTIVE_GLOBAL_CONCURRENCY: z.coerce.number().int().positive().max(2).default(1),
  OBJECTIVE_DEPARTMENT_CONCURRENCY: z.coerce.number().int().positive().max(2).default(1),
  EMBEDDING_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  EMBEDDING_MODEL: z.string().min(1).default("embeddinggemma"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(4096).default(768),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  EMBEDDING_MAX_CONCURRENCY: z.coerce.number().int().positive().max(2).default(1),
  EMBEDDING_TRANSPORT_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  MEMORY_TOP_K: z.coerce.number().int().positive().max(20).default(5),
  MEMORY_CONTEXT_TOKENS: z.coerce.number().int().positive().max(4000).default(800),
  MEMORY_MAX_WRITES_PER_OBJECTIVE: z.coerce.number().int().positive().max(50).default(12),
});

export interface InferenceConfig {
  baseUrl: string;
  apiKey: string | null;
  alias: string;
  operationalBaseUrl: string | null;
  operationalAlias: string | null;
  memoryProfile: "shared" | "split";
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  maxConcurrency: number;
  transportRetries: number;
  probeTimeoutMs: number;
  probeFreshnessMs: number;
  probeMinIntervalMs: number;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  globalConcurrency: number;
  departmentConcurrency: number;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingTimeoutMs: number;
  embeddingConcurrency: number;
  embeddingRetries: number;
  memoryTopK: number;
  memoryContextTokens: number;
  memoryMaxWritesPerObjective: number;
}

export function loadInferenceConfig(env: NodeJS.ProcessEnv): InferenceConfig {
  const parsed = schema.parse(env);
  return {
    baseUrl: parsed.INFERENCE_BASE_URL,
    apiKey: parsed.INFERENCE_API_KEY ?? null,
    alias: parsed.INFERENCE_MODEL_ALIAS,
    operationalBaseUrl: parsed.INFERENCE_OPERATIONAL_BASE_URL ?? null,
    operationalAlias: parsed.INFERENCE_OPERATIONAL_ALIAS ?? null,
    memoryProfile: parsed.INFERENCE_MEMORY_PROFILE,
    contextWindow: parsed.INFERENCE_CONTEXT_WINDOW,
    maxOutputTokens: parsed.INFERENCE_MAX_OUTPUT_TOKENS,
    temperature: parsed.INFERENCE_TEMPERATURE,
    timeoutMs: parsed.INFERENCE_TIMEOUT_MS,
    maxConcurrency: parsed.INFERENCE_MAX_CONCURRENCY,
    transportRetries: parsed.INFERENCE_TRANSPORT_RETRIES,
    probeTimeoutMs: parsed.OLLAMA_PROBE_TIMEOUT_MS,
    probeFreshnessMs: parsed.OLLAMA_PROBE_FRESHNESS_MS,
    probeMinIntervalMs: parsed.OLLAMA_PROBE_MIN_INTERVAL_MS,
    inputUsdPerMillion: parsed.INFERENCE_INPUT_USD_PER_MILLION ?? null,
    outputUsdPerMillion: parsed.INFERENCE_OUTPUT_USD_PER_MILLION ?? null,
    globalConcurrency: parsed.OBJECTIVE_GLOBAL_CONCURRENCY,
    departmentConcurrency: parsed.OBJECTIVE_DEPARTMENT_CONCURRENCY,
    embeddingBaseUrl: parsed.EMBEDDING_BASE_URL,
    embeddingModel: parsed.EMBEDDING_MODEL,
    embeddingDimensions: parsed.EMBEDDING_DIMENSIONS,
    embeddingTimeoutMs: parsed.EMBEDDING_TIMEOUT_MS,
    embeddingConcurrency: parsed.EMBEDDING_MAX_CONCURRENCY,
    embeddingRetries: parsed.EMBEDDING_TRANSPORT_RETRIES,
    memoryTopK: parsed.MEMORY_TOP_K,
    memoryContextTokens: parsed.MEMORY_CONTEXT_TOKENS,
    memoryMaxWritesPerObjective: parsed.MEMORY_MAX_WRITES_PER_OBJECTIVE,
  };
}

export function routeFromConfig(config: InferenceConfig) {
  return {
    memoryProfile: config.memoryProfile,
    alias: config.alias,
    operationalAlias: config.memoryProfile === "split" ? config.operationalAlias : null,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    rates: {
      inputUsdPerMillion: config.inputUsdPerMillion,
      outputUsdPerMillion: config.outputUsdPerMillion,
    },
    globalConcurrency: config.globalConcurrency,
    departmentConcurrency: config.departmentConcurrency,
  };
}
