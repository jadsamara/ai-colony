import { z } from "zod";

const nodeEnvSchema = z.enum(["development", "test", "production"]);
const authModeSchema = z.enum(["development", "disabled"]);
const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const envSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  PORT: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(65535).default(3000),
  ),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres URL",
    ),
  AUTH_MODE: authModeSchema.default("disabled"),
  LOG_LEVEL: logLevelSchema.default("info"),
  RUNTIME_STALE_AFTER_MS: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(86_400_000).default(30_000),
  ),
});

export interface AppConfig {
  nodeEnv: z.infer<typeof nodeEnvSchema>;
  port: number;
  host: string;
  databaseUrl: string;
  authMode: z.infer<typeof authModeSchema>;
  logLevel: z.infer<typeof logLevelSchema>;
  runtimeStaleAfterMs: number;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.AUTH_MODE === "development") {
    throw new Error(
      "Refusing to start: AUTH_MODE=development cannot be used when NODE_ENV=production.",
    );
  }
  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    host: parsed.data.HOST,
    databaseUrl: parsed.data.DATABASE_URL,
    authMode: parsed.data.AUTH_MODE,
    logLevel: parsed.data.LOG_LEVEL,
    runtimeStaleAfterMs: parsed.data.RUNTIME_STALE_AFTER_MS,
  };
}
