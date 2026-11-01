CREATE TABLE "candidate_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"baseline" jsonb NOT NULL,
	"candidate" jsonb NOT NULL,
	"acceptance_met" boolean NOT NULL,
	"criteria" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_evaluations_candidate_unique" UNIQUE("candidate_id")
);
--> statement-breakpoint
CREATE TABLE "model_adapters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artifact_id" uuid NOT NULL,
	"base_trainable_model_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"alpha" double precision NOT NULL,
	"dropout" double precision NOT NULL,
	"target_modules" jsonb NOT NULL,
	"trainable_parameters" bigint NOT NULL,
	"framework" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_adapters_artifact_unique" UNIQUE("artifact_id"),
	CONSTRAINT "model_adapters_rank_check" CHECK ("model_adapters"."rank" >= 1 and "model_adapters"."rank" <= 16),
	CONSTRAINT "model_adapters_parameters_check" CHECK ("model_adapters"."trainable_parameters" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"adapter_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_candidates_run_unique" UNIQUE("run_id"),
	CONSTRAINT "model_candidates_status_check" CHECK (status in ('experimental', 'rejected', 'approved', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "model_promotion_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"status" text NOT NULL,
	"proposed_by" text NOT NULL,
	"decided_by" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "model_promotion_requests_status_check" CHECK (status in ('proposed', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "model_version_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trainable_model_id" uuid,
	"candidate_id" uuid,
	"run_id" uuid,
	"event_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trainable_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registry_model_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"model_family" text NOT NULL,
	"source" text NOT NULL,
	"revision" text NOT NULL,
	"parameter_count" bigint NOT NULL,
	"precision" text NOT NULL,
	"architecture" text NOT NULL,
	"tokenizer_id" text NOT NULL,
	"context_length" integer NOT NULL,
	"framework" text NOT NULL,
	"framework_version" text NOT NULL,
	"artifact_uri" text NOT NULL,
	"sha256" text NOT NULL,
	"license" text NOT NULL,
	"available_locally" boolean NOT NULL,
	"eligible_for_training" boolean NOT NULL,
	"serving_ready" boolean NOT NULL,
	"compatibility" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trainable_models_registry_sha_unique" UNIQUE("registry_model_id","sha256"),
	CONSTRAINT "trainable_models_kind_check" CHECK (kind in ('trainable_checkpoint')),
	CONSTRAINT "trainable_models_parameter_count_check" CHECK ("trainable_models"."parameter_count" > 0),
	CONSTRAINT "trainable_models_context_check" CHECK ("trainable_models"."context_length" > 0),
	CONSTRAINT "trainable_models_sha_check" CHECK (char_length("trainable_models"."sha256") = 64)
);
--> statement-breakpoint
CREATE TABLE "training_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"relative_path" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"format" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_artifacts_run_sha_unique" UNIQUE("run_id","sha256"),
	CONSTRAINT "training_artifacts_kind_check" CHECK (kind in ('adapter', 'checkpoint')),
	CONSTRAINT "training_artifacts_format_check" CHECK (format in ('safetensors', 'float32-bin')),
	CONSTRAINT "training_artifacts_size_check" CHECK ("training_artifacts"."byte_size" > 0 and "training_artifacts"."byte_size" <= 200000000),
	CONSTRAINT "training_artifacts_sha_check" CHECK (char_length("training_artifacts"."sha256") = 64)
);
--> statement-breakpoint
CREATE TABLE "training_dataset_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"split_seed" integer NOT NULL,
	"status" text NOT NULL,
	"train_count" integer NOT NULL,
	"validation_count" integer NOT NULL,
	"test_count" integer NOT NULL,
	"criteria" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_dataset_versions_dataset_version_unique" UNIQUE("dataset_id","version"),
	CONSTRAINT "training_dataset_versions_status_check" CHECK (status in ('sealed')),
	CONSTRAINT "training_dataset_versions_version_check" CHECK ("training_dataset_versions"."version" >= 1),
	CONSTRAINT "training_dataset_versions_counts_check" CHECK ("training_dataset_versions"."train_count" >= 0 and "training_dataset_versions"."validation_count" >= 0 and "training_dataset_versions"."test_count" >= 0),
	CONSTRAINT "training_dataset_versions_hash_check" CHECK (char_length("training_dataset_versions"."content_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "training_datasets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"task_domain" text NOT NULL,
	"idempotency_key" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_datasets_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "training_examples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"split" text NOT NULL,
	"group_key" text NOT NULL,
	"source" text NOT NULL,
	"license" text NOT NULL,
	"input_text" text NOT NULL,
	"expected_output" text NOT NULL,
	"validation_status" text NOT NULL,
	"source_memory_id" uuid,
	"source_objective_id" uuid,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_examples_version_group_unique" UNIQUE("version_id","group_key"),
	CONSTRAINT "training_examples_version_hash_unique" UNIQUE("version_id","content_hash"),
	CONSTRAINT "training_examples_split_check" CHECK (split in ('train', 'validation', 'test')),
	CONSTRAINT "training_examples_source_check" CHECK (source in ('curated_arithmetic', 'supplied', 'memory', 'objective_trace')),
	CONSTRAINT "training_examples_validation_check" CHECK ("training_examples"."validation_status" = 'verified'),
	CONSTRAINT "training_examples_hash_check" CHECK (char_length("training_examples"."content_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "training_run_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"train_loss" double precision,
	"validation_loss" double precision,
	"learning_rate" double precision,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_run_metrics_step_check" CHECK ("training_run_metrics"."step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "training_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_version_id" uuid NOT NULL,
	"trainable_model_id" uuid NOT NULL,
	"parent_run_id" uuid,
	"profile" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"seed" integer NOT NULL,
	"attempt" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"config" jsonb NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_runs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "training_runs_status_check" CHECK (status in ('proposed', 'awaiting_approval', 'queued', 'preparing', 'training', 'evaluating', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "training_runs_attempt_check" CHECK ("training_runs"."attempt" >= 1 and "training_runs"."attempt" <= "training_runs"."max_attempts"),
	CONSTRAINT "training_runs_seed_check" CHECK ("training_runs"."seed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "candidate_evaluations" ADD CONSTRAINT "candidate_evaluations_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_evaluations" ADD CONSTRAINT "candidate_evaluations_run_id_training_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."training_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_adapters" ADD CONSTRAINT "model_adapters_artifact_id_training_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."training_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_adapters" ADD CONSTRAINT "model_adapters_base_trainable_model_id_trainable_models_id_fk" FOREIGN KEY ("base_trainable_model_id") REFERENCES "public"."trainable_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD CONSTRAINT "model_candidates_adapter_id_model_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."model_adapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD CONSTRAINT "model_candidates_run_id_training_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."training_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_promotion_requests" ADD CONSTRAINT "model_promotion_requests_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_version_events" ADD CONSTRAINT "model_version_events_trainable_model_id_trainable_models_id_fk" FOREIGN KEY ("trainable_model_id") REFERENCES "public"."trainable_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_version_events" ADD CONSTRAINT "model_version_events_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_version_events" ADD CONSTRAINT "model_version_events_run_id_training_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."training_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainable_models" ADD CONSTRAINT "trainable_models_registry_model_id_models_id_fk" FOREIGN KEY ("registry_model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_artifacts" ADD CONSTRAINT "training_artifacts_run_id_training_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."training_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_dataset_versions" ADD CONSTRAINT "training_dataset_versions_dataset_id_training_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."training_datasets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_examples" ADD CONSTRAINT "training_examples_version_id_training_dataset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."training_dataset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_examples" ADD CONSTRAINT "training_examples_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_examples" ADD CONSTRAINT "training_examples_source_objective_id_objective_runs_id_fk" FOREIGN KEY ("source_objective_id") REFERENCES "public"."objective_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_run_metrics" ADD CONSTRAINT "training_run_metrics_run_id_training_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."training_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_runs" ADD CONSTRAINT "training_runs_dataset_version_id_training_dataset_versions_id_fk" FOREIGN KEY ("dataset_version_id") REFERENCES "public"."training_dataset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_runs" ADD CONSTRAINT "training_runs_trainable_model_id_trainable_models_id_fk" FOREIGN KEY ("trainable_model_id") REFERENCES "public"."trainable_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_runs" ADD CONSTRAINT "training_runs_parent_run_id_training_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."training_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_candidates_status_idx" ON "model_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "model_promotion_requests_candidate_idx" ON "model_promotion_requests" USING btree ("candidate_id","created_at");--> statement-breakpoint
CREATE INDEX "model_version_events_run_idx" ON "model_version_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "trainable_models_family_idx" ON "trainable_models" USING btree ("model_family");--> statement-breakpoint
CREATE INDEX "training_datasets_created_at_idx" ON "training_datasets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "training_examples_split_idx" ON "training_examples" USING btree ("version_id","split");--> statement-breakpoint
CREATE INDEX "training_run_metrics_run_step_idx" ON "training_run_metrics" USING btree ("run_id","step");--> statement-breakpoint
CREATE INDEX "training_runs_status_idx" ON "training_runs" USING btree ("status","created_at");