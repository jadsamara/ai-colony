ALTER TABLE "colony_autonomy" ADD COLUMN "conversation_execution_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "colony_autonomy" ADD COLUMN "max_concurrent_conversation_turns" integer NOT NULL DEFAULT 1;
ALTER TABLE "colony_autonomy" ADD COLUMN "context_token_budget" integer NOT NULL DEFAULT 1500;
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_conversation_turns_check" CHECK ("max_concurrent_conversation_turns" between 1 and 4);
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_context_budget_check" CHECK ("context_token_budget" between 200 and 8000);

ALTER TABLE "department_conversations" ADD COLUMN "outcome" text;
ALTER TABLE "department_conversations" ADD CONSTRAINT "department_conversations_outcome_check" CHECK ("outcome" is null or "outcome" in ('resolved', 'unresolved', 'budget_exhausted', 'cancelled', 'failed', 'administratively_stopped'));
ALTER TABLE "department_conversations" ADD COLUMN "paused" boolean NOT NULL DEFAULT false;
ALTER TABLE "department_conversations" ADD COLUMN "runner_status" text NOT NULL DEFAULT 'idle';
ALTER TABLE "department_conversations" ADD CONSTRAINT "department_conversations_runner_check" CHECK ("runner_status" in ('idle', 'scheduled', 'running', 'paused', 'waiting_on_child', 'stopped'));
ALTER TABLE "department_conversations" ADD COLUMN "runner_fence" integer NOT NULL DEFAULT 0;
ALTER TABLE "department_conversations" ADD COLUMN "runner_lease_until" timestamptz;
ALTER TABLE "department_conversations" ADD COLUMN "parent_conversation_id" uuid;
ALTER TABLE "department_conversations" ADD COLUMN "scheduled_speaker_id" uuid;
ALTER TABLE "department_conversations" ADD COLUMN "last_error" text;
ALTER TABLE "department_conversations" ADD COLUMN "last_inference_latency_ms" integer;
ALTER TABLE "department_conversations" ADD CONSTRAINT "department_conversations_parent_fk" FOREIGN KEY ("parent_conversation_id") REFERENCES "department_conversations"("id") ON DELETE restrict;

CREATE TABLE "conversation_jobs" (
  "id" uuid PRIMARY KEY,
  "conversation_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "fence" integer NOT NULL,
  "status" text NOT NULL,
  "action" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 0,
  "lease_token" uuid,
  "lease_until" timestamptz,
  "speaker_department_id" uuid,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "conversation_jobs_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "department_conversations"("id") ON DELETE restrict,
  CONSTRAINT "conversation_jobs_speaker_fk" FOREIGN KEY ("speaker_department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "conversation_jobs_key_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "conversation_jobs_status_check" CHECK ("status" in ('pending', 'leased', 'completed', 'dead')),
  CONSTRAINT "conversation_jobs_action_check" CHECK ("action" in ('speak', 'invitation'))
);

CREATE UNIQUE INDEX "conversation_jobs_one_active" ON "conversation_jobs" ("conversation_id") WHERE "status" in ('pending', 'leased');
CREATE INDEX "conversation_jobs_status_idx" ON "conversation_jobs" ("status", "created_at");

CREATE TABLE "conversation_context_events" (
  "id" uuid PRIMARY KEY,
  "conversation_id" uuid NOT NULL,
  "department_id" uuid,
  "kind" text NOT NULL,
  "query" text NOT NULL,
  "message_ids" jsonb NOT NULL,
  "tokens" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_context_events_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "department_conversations"("id") ON DELETE restrict,
  CONSTRAINT "conversation_context_events_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "conversation_context_events_kind_check" CHECK ("kind" in ('search', 'summary'))
);

CREATE INDEX "conversation_context_events_conversation_idx" ON "conversation_context_events" ("conversation_id", "created_at");
