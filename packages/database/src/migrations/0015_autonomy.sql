ALTER TABLE "objective_runs" ADD COLUMN "origin" text NOT NULL DEFAULT 'human';
ALTER TABLE "objective_runs" ADD CONSTRAINT "objective_runs_origin_check" CHECK ("origin" in ('human', 'autonomous'));

ALTER TABLE "messages" DROP CONSTRAINT "messages_type_check";
ALTER TABLE "messages" ADD CONSTRAINT "messages_type_check" CHECK ("message_type" in ('TASK_REQUEST', 'TASK_RESULT', 'COLLABORATION_REQUEST', 'KNOWLEDGE_SHARE', 'TRAINING_REQUEST', 'MODEL_CANDIDATE', 'EVALUATION_RESULT', 'RESOURCE_REQUEST', 'HEALTH_ALERT', 'EVOLUTION_PROPOSAL', 'CAPABILITY_GAP', 'LEARNING_OBJECTIVE', 'KNOWLEDGE_TRANSFER', 'KNOWLEDGE_VALIDATION', 'LEARNING_CYCLE_RESULT', 'CAPABILITY_UPDATE', 'DEPARTMENT_DIALOGUE'));

CREATE TABLE "colony_autonomy" (
  "id" text PRIMARY KEY,
  "enabled" boolean NOT NULL DEFAULT false,
  "paused" boolean NOT NULL DEFAULT false,
  "interval_ms" integer NOT NULL,
  "cooldown_ms" integer NOT NULL,
  "max_active_goals" integer NOT NULL,
  "max_inference_requests" integer NOT NULL,
  "max_duration_ms" integer NOT NULL,
  "max_conversations" integer NOT NULL,
  "max_conversation_messages" integer NOT NULL,
  "max_conversation_tokens" integer NOT NULL,
  "last_cycle_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "colony_autonomy" (
  "id", "enabled", "paused", "interval_ms", "cooldown_ms", "max_active_goals",
  "max_inference_requests", "max_duration_ms", "max_conversations",
  "max_conversation_messages", "max_conversation_tokens"
) VALUES ('default', false, false, 86400000, 3600000, 1, 1, 1800000, 4, 12, 4000);

CREATE TABLE "colony_goal_cycles" (
  "id" uuid PRIMARY KEY,
  "outcome" text NOT NULL,
  "rationale" text NOT NULL,
  "goal_id" uuid,
  "prompt" jsonb NOT NULL,
  "response_text" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "colony_goal_cycles_created_idx" ON "colony_goal_cycles" ("created_at");

CREATE TABLE "colony_goals" (
  "id" uuid PRIMARY KEY,
  "objective_id" uuid NOT NULL,
  "description" text NOT NULL,
  "normalized_description" text NOT NULL,
  "motivation" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "hypotheses" jsonb NOT NULL,
  "expected_benefit" text NOT NULL,
  "success_criteria" jsonb NOT NULL,
  "estimated_inference_requests" integer NOT NULL,
  "departments" jsonb NOT NULL,
  "priority" text NOT NULL,
  "stop_conditions" jsonb NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "colony_goals_objective_fk" FOREIGN KEY ("objective_id") REFERENCES "objective_runs"("id") ON DELETE restrict,
  CONSTRAINT "colony_goals_status_check" CHECK ("status" in ('selected', 'cancelled', 'completed', 'failed')),
  CONSTRAINT "colony_goals_priority_check" CHECK ("priority" in ('low', 'medium', 'high'))
);

CREATE INDEX "colony_goals_status_idx" ON "colony_goals" ("status", "created_at");

CREATE TABLE "objective_subgoals" (
  "id" uuid PRIMARY KEY,
  "objective_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "description" text NOT NULL,
  "status" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "objective_subgoals_objective_fk" FOREIGN KEY ("objective_id") REFERENCES "objective_runs"("id") ON DELETE restrict,
  CONSTRAINT "objective_subgoals_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "objective_subgoals_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE restrict,
  CONSTRAINT "objective_subgoals_key_unique" UNIQUE ("idempotency_key")
);

CREATE INDEX "objective_subgoals_objective_idx" ON "objective_subgoals" ("objective_id", "created_at");

CREATE TABLE "department_conversations" (
  "id" uuid PRIMARY KEY,
  "topic" text NOT NULL,
  "objective_id" uuid,
  "opened_by_department_id" uuid NOT NULL,
  "status" text NOT NULL,
  "message_count" integer NOT NULL DEFAULT 0,
  "inference_requests" integer NOT NULL DEFAULT 0,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "max_messages" integer NOT NULL,
  "max_tokens" integer NOT NULL,
  "max_duration_ms" integer NOT NULL,
  "close_reason" text,
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  "last_turn_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  CONSTRAINT "department_conversations_objective_fk" FOREIGN KEY ("objective_id") REFERENCES "objective_runs"("id") ON DELETE restrict,
  CONSTRAINT "department_conversations_opener_fk" FOREIGN KEY ("opened_by_department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "department_conversations_status_check" CHECK ("status" in ('open', 'resolved', 'unresolved', 'terminated'))
);

CREATE INDEX "department_conversations_status_idx" ON "department_conversations" ("status", "opened_at");

CREATE TABLE "conversation_participants" (
  "conversation_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  PRIMARY KEY ("conversation_id", "department_id"),
  CONSTRAINT "conversation_participants_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "department_conversations"("id") ON DELETE restrict,
  CONSTRAINT "conversation_participants_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict
);

CREATE TABLE "conversation_turns" (
  "id" uuid PRIMARY KEY,
  "conversation_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "body" text NOT NULL,
  "parent_message_id" uuid,
  "prompt" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_turns_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "department_conversations"("id") ON DELETE restrict,
  CONSTRAINT "conversation_turns_message_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE restrict,
  CONSTRAINT "conversation_turns_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "conversation_turns_key_unique" UNIQUE ("idempotency_key")
);

CREATE INDEX "conversation_turns_conversation_idx" ON "conversation_turns" ("conversation_id", "created_at");
