ALTER TABLE "colony_autonomy" ADD COLUMN "max_conversation_participants" integer NOT NULL DEFAULT 12;
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_participants_check" CHECK ("max_conversation_participants" between 2 and 12);

ALTER TABLE "department_conversations" ADD COLUMN "final_conclusion" text;
ALTER TABLE "department_conversations" ADD COLUMN "remaining_disagreements" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "department_conversations" ADD COLUMN "evidence_refs" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "department_conversations" ADD COLUMN "context_summary" text;
ALTER TABLE "department_conversations" ADD COLUMN "next_sequence" integer NOT NULL DEFAULT 0;

ALTER TABLE "conversation_participants" ADD COLUMN "membership" text NOT NULL DEFAULT 'active';
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_membership_check" CHECK ("membership" in ('active', 'invited', 'declined', 'removed'));
ALTER TABLE "conversation_participants" ADD COLUMN "invited_by_department_id" uuid;
ALTER TABLE "conversation_participants" ADD COLUMN "joined_at" timestamptz;
ALTER TABLE "conversation_participants" ADD COLUMN "removed_at" timestamptz;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_inviter_fk" FOREIGN KEY ("invited_by_department_id") REFERENCES "departments"("id") ON DELETE restrict;

CREATE TABLE "conversation_membership_events" (
  "id" uuid PRIMARY KEY,
  "conversation_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "action" text NOT NULL,
  "actor_department_id" uuid,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_membership_events_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "department_conversations"("id") ON DELETE restrict,
  CONSTRAINT "conversation_membership_events_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "conversation_membership_events_actor_fk" FOREIGN KEY ("actor_department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "conversation_membership_events_action_check" CHECK ("action" in ('joined', 'invited', 'accepted', 'declined', 'removed'))
);

CREATE INDEX "conversation_membership_events_conversation_idx" ON "conversation_membership_events" ("conversation_id", "created_at");

ALTER TABLE "conversation_turns" ADD COLUMN "addressed_department_id" uuid;
ALTER TABLE "conversation_turns" ADD COLUMN "sequence" integer NOT NULL DEFAULT 0;
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_addressed_fk" FOREIGN KEY ("addressed_department_id") REFERENCES "departments"("id") ON DELETE restrict;

CREATE TABLE "conversation_turn_claims" (
  "idempotency_key" text PRIMARY KEY,
  "conversation_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "addressed_department_id" uuid,
  "parent_message_id" uuid,
  "sequence" integer NOT NULL,
  "body" text,
  "prompt" jsonb,
  "input_tokens" integer,
  "output_tokens" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_turn_claims_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "department_conversations"("id") ON DELETE restrict,
  CONSTRAINT "conversation_turn_claims_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "conversation_turn_claims_addressed_fk" FOREIGN KEY ("addressed_department_id") REFERENCES "departments"("id") ON DELETE restrict
);

CREATE INDEX "conversation_turn_claims_conversation_idx" ON "conversation_turn_claims" ("conversation_id", "sequence");
