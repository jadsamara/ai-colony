CREATE TABLE "training_inference_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" uuid,
	"department_id" uuid NOT NULL,
	"model_registry_id" uuid,
	"model_version" text,
	"adapter_id" uuid,
	"adapter_version" text,
	"inference_endpoint" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"parent_attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prompt_hash" text NOT NULL,
	"prompt_snapshot" text,
	"prompt_truncated" boolean DEFAULT false NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer NOT NULL,
	"raw_output" text,
	"raw_output_hash" text NOT NULL,
	"raw_truncated" boolean DEFAULT false NOT NULL,
	"raw_expired" boolean DEFAULT false NOT NULL,
	"parsed_output" jsonb,
	"validation_result" text,
	"acceptance_status" text NOT NULL,
	"failure_class" text,
	"failure_symptom" text,
	"failure_root_cause" text,
	"failure_provisional" boolean DEFAULT true NOT NULL,
	"classification_source" text DEFAULT 'runtime' NOT NULL,
	"classification_confidence" text DEFAULT 'observed' NOT NULL,
	"classification_evidence" text,
	"recovery_of_attempt_id" uuid,
	"training_eligible" boolean DEFAULT false NOT NULL,
	"eligibility_status" text DEFAULT 'not_reviewed' NOT NULL,
	"capture_status" text DEFAULT 'captured' NOT NULL,
	"capture_error" text
);
--> statement-breakpoint
CREATE TABLE "training_evidence_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"proposed_response" text NOT NULL,
	"artifact_ref" text,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verifier_id" text,
	"verification_method" text,
	"supporting_evidence" text,
	"department_id" uuid,
	"model_registry_id" uuid,
	"task_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_evidence_correction_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"correction_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_id" text NOT NULL,
	"method" text,
	"evidence" text,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_evidence_eligibility_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"from_eligible" boolean NOT NULL,
	"to_eligible" boolean NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_evidence_capture_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid,
	"department_id" uuid,
	"attempt_number" integer,
	"error" text NOT NULL,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."department_conversations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_turn_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_department_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_model_fk" FOREIGN KEY ("model_registry_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_parent_fk" FOREIGN KEY ("parent_attempt_id") REFERENCES "public"."training_inference_attempts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_recovery_fk" FOREIGN KEY ("recovery_of_attempt_id") REFERENCES "public"."training_inference_attempts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_evidence_corrections" ADD CONSTRAINT "training_evidence_corrections_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."training_inference_attempts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_evidence_corrections" ADD CONSTRAINT "training_evidence_corrections_department_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_evidence_corrections" ADD CONSTRAINT "training_evidence_corrections_model_fk" FOREIGN KEY ("model_registry_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_evidence_correction_events" ADD CONSTRAINT "training_evidence_correction_events_correction_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."training_evidence_corrections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_evidence_eligibility_events" ADD CONSTRAINT "training_evidence_eligibility_events_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."training_inference_attempts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_evidence_capture_failures" ADD CONSTRAINT "training_evidence_capture_failures_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."department_conversations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_evidence_capture_failures" ADD CONSTRAINT "training_evidence_capture_failures_department_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "training_inference_attempts_conversation_idx" ON "training_inference_attempts" USING btree ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX "training_inference_attempts_department_idx" ON "training_inference_attempts" USING btree ("department_id","created_at");
--> statement-breakpoint
CREATE INDEX "training_inference_attempts_model_idx" ON "training_inference_attempts" USING btree ("model_registry_id","created_at");
--> statement-breakpoint
CREATE INDEX "training_inference_attempts_failure_idx" ON "training_inference_attempts" USING btree ("failure_class","acceptance_status","created_at");
--> statement-breakpoint
CREATE INDEX "training_inference_attempts_parent_idx" ON "training_inference_attempts" USING btree ("parent_attempt_id");
--> statement-breakpoint
CREATE INDEX "training_evidence_corrections_attempt_idx" ON "training_evidence_corrections" USING btree ("attempt_id","created_at");
--> statement-breakpoint
CREATE INDEX "training_evidence_correction_events_correction_idx" ON "training_evidence_correction_events" USING btree ("correction_id","created_at");
--> statement-breakpoint
CREATE INDEX "training_evidence_eligibility_events_attempt_idx" ON "training_evidence_eligibility_events" USING btree ("attempt_id","created_at");
--> statement-breakpoint
CREATE INDEX "training_evidence_capture_failures_created_idx" ON "training_evidence_capture_failures" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_attempt_number_check" CHECK ("attempt_number" >= 1);
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_latency_check" CHECK ("latency_ms" >= 0);
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_acceptance_check" CHECK ("acceptance_status" in ('accepted', 'rejected', 'recovered', 'failed', 'partial'));
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_failure_class_check" CHECK ("failure_class" is null or "failure_class" in ('json_invalid', 'schema_invalid', 'serialization_error', 'meta_validation_chatter', 'repetition', 'context_missing', 'orchestration_failure', 'math_unverified', 'unsupported_evidence', 'reasoning_error', 'inference_timeout', 'inference_error', 'unknown'));
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_classification_source_check" CHECK ("classification_source" in ('runtime', 'human', 'evaluation', 'system'));
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_classification_confidence_check" CHECK ("classification_confidence" in ('observed', 'provisional', 'reviewed', 'verified'));
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_eligibility_status_check" CHECK ("eligibility_status" in ('not_reviewed', 'ineligible', 'candidate', 'verified_for_dataset'));
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_capture_status_check" CHECK ("capture_status" in ('captured', 'capture_failed', 'unavailable'));
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_prompt_hash_check" CHECK (char_length("prompt_hash") = 64);
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_raw_hash_check" CHECK (char_length("raw_output_hash") = 64);
--> statement-breakpoint
ALTER TABLE "training_inference_attempts" ADD CONSTRAINT "training_inference_attempts_eligible_default_check" CHECK ("training_eligible" = false or "eligibility_status" = 'verified_for_dataset');
--> statement-breakpoint
ALTER TABLE "training_evidence_corrections" ADD CONSTRAINT "training_evidence_corrections_author_type_check" CHECK ("author_type" in ('human', 'evaluation', 'system'));
--> statement-breakpoint
ALTER TABLE "training_evidence_corrections" ADD CONSTRAINT "training_evidence_corrections_status_check" CHECK ("verification_status" in ('unverified', 'verified', 'rejected'));
--> statement-breakpoint
ALTER TABLE "training_evidence_corrections" ADD CONSTRAINT "training_evidence_corrections_revision_check" CHECK ("revision" >= 1);
--> statement-breakpoint
ALTER TABLE "training_evidence_correction_events" ADD CONSTRAINT "training_evidence_correction_events_type_check" CHECK ("event_type" in ('proposed', 'verified', 'rejected', 'revised'));
--> statement-breakpoint
ALTER TABLE "training_evidence_eligibility_events" ADD CONSTRAINT "training_evidence_eligibility_events_to_check" CHECK ("to_status" in ('not_reviewed', 'ineligible', 'candidate', 'verified_for_dataset'));
--> statement-breakpoint
ALTER TABLE "training_evidence_eligibility_events" ADD CONSTRAINT "training_evidence_eligibility_events_eligible_check" CHECK ("to_eligible" = false or "to_status" = 'verified_for_dataset');
