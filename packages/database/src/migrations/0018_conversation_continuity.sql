ALTER TABLE "colony_autonomy" ADD COLUMN "conversation_soft_token_budget" integer DEFAULT 20000 NOT NULL;
ALTER TABLE "colony_autonomy" ADD COLUMN "conversation_hard_token_ceiling" integer DEFAULT 60000 NOT NULL;
ALTER TABLE "colony_autonomy" ADD COLUMN "conversation_checkpoint_turns" integer DEFAULT 10 NOT NULL;
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_soft_budget_check" CHECK ("conversation_soft_token_budget" between 1 and 200000);
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_hard_ceiling_check" CHECK ("conversation_hard_token_ceiling" between 1 and 200000);
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_ceiling_above_soft_check" CHECK ("conversation_hard_token_ceiling" >= "conversation_soft_token_budget");
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_checkpoint_turns_check" CHECK ("conversation_checkpoint_turns" between 1 and 100);
ALTER TABLE "department_conversations" ADD COLUMN "last_inference_endpoint" text;
ALTER TABLE "department_conversations" ADD COLUMN "progress_state" jsonb DEFAULT '{}'::jsonb NOT NULL;
