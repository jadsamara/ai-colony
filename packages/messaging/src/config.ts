import { z } from "zod";
import { DEFAULT_MESSAGING_POLICY, type MessagingPolicy } from "@ai-colony/core";

const optionalNumber = (fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : value),
    z.coerce.number().int().nonnegative().default(fallback),
  );

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres URL",
    ),
  RABBITMQ_URL: z.string().startsWith("amqp"),
  MESSAGING_PREFETCH: optionalNumber(DEFAULT_MESSAGING_POLICY.prefetch),
  MESSAGING_MAX_HANDLER_ATTEMPTS: optionalNumber(DEFAULT_MESSAGING_POLICY.maxHandlerAttempts),
  MESSAGING_MAX_PUBLISH_ATTEMPTS: optionalNumber(DEFAULT_MESSAGING_POLICY.maxPublishAttempts),
  MESSAGING_RETRY_BASE_MS: optionalNumber(DEFAULT_MESSAGING_POLICY.retryBaseMs),
  MESSAGING_RETRY_MAX_DELAY_MS: optionalNumber(DEFAULT_MESSAGING_POLICY.retryMaxDelayMs),
  MESSAGING_LEASE_MS: optionalNumber(DEFAULT_MESSAGING_POLICY.leaseMs),
  MESSAGING_POLL_MS: optionalNumber(DEFAULT_MESSAGING_POLICY.pollMs),
  MESSAGING_BATCH_SIZE: optionalNumber(DEFAULT_MESSAGING_POLICY.batchSize),
});

export interface WorkerConfig {
  databaseUrl: string;
  rabbitUrl: string;
  policy: MessagingPolicy;
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    rabbitUrl: parsed.data.RABBITMQ_URL,
    policy: {
      prefetch: parsed.data.MESSAGING_PREFETCH,
      maxHandlerAttempts: parsed.data.MESSAGING_MAX_HANDLER_ATTEMPTS,
      maxPublishAttempts: parsed.data.MESSAGING_MAX_PUBLISH_ATTEMPTS,
      retryBaseMs: parsed.data.MESSAGING_RETRY_BASE_MS,
      retryMaxDelayMs: parsed.data.MESSAGING_RETRY_MAX_DELAY_MS,
      leaseMs: parsed.data.MESSAGING_LEASE_MS,
      pollMs: parsed.data.MESSAGING_POLL_MS,
      batchSize: parsed.data.MESSAGING_BATCH_SIZE,
    },
  };
}
