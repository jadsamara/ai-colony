CREATE TABLE "artifact_contamination" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artifact_id" uuid NOT NULL,
	"forgetting_request_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_contamination_artifact_request_unique" UNIQUE("artifact_id","forgetting_request_id")
);
--> statement-breakpoint
CREATE TABLE "benchmark_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"domain" text NOT NULL,
	"prompt" text NOT NULL,
	"expected" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"sealed" boolean NOT NULL,
	CONSTRAINT "benchmark_items_version_ordinal_unique" UNIQUE("version_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "benchmark_suites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmark_suites_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "benchmark_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"suite_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"domain" text NOT NULL,
	"source" text NOT NULL,
	"license" text NOT NULL,
	"protocol" text NOT NULL,
	"scorer_id" text NOT NULL,
	"scorer_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"prompt_template_hash" text NOT NULL,
	"decoding" jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"status" text NOT NULL,
	"sealed" boolean NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmark_versions_suite_version_unique" UNIQUE("suite_id","version"),
	CONSTRAINT "benchmark_versions_status_check" CHECK (status in ('draft', 'published', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "candidate_gate_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"rationale" text NOT NULL,
	"policy_hash" text NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_gate_decisions_decision_check" CHECK (decision in ('PASS', 'FAIL', 'INCONCLUSIVE', 'QUARANTINED'))
);
--> statement-breakpoint
CREATE TABLE "evaluation_item_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"role" text NOT NULL,
	"raw_output" text NOT NULL,
	"task_correct" boolean NOT NULL,
	"format_valid" boolean NOT NULL,
	"strict_integer_match" boolean NOT NULL,
	"ambiguous" boolean NOT NULL,
	"equation_value" text,
	CONSTRAINT "evaluation_item_results_run_ordinal_role_unique" UNIQUE("run_id","ordinal","role"),
	CONSTRAINT "evaluation_item_results_role_check" CHECK (role in ('baseline', 'candidate'))
);
--> statement-breakpoint
CREATE TABLE "evaluation_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_reports_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"benchmark_version_id" uuid NOT NULL,
	"candidate_id" uuid,
	"trainable_model_id" uuid,
	"base_sha256" text NOT NULL,
	"adapter_sha256" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"decoding" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "evaluation_runs_status_check" CHECK (status in ('completed', 'failed')),
	CONSTRAINT "evaluation_runs_source_check" CHECK (source in ('live', 'historical'))
);
--> statement-breakpoint
CREATE TABLE "experimental_route_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"route_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"candidate_id" uuid,
	"trainable_model_id" uuid NOT NULL,
	"adapter_sha256" text,
	"base_sha256" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experimental_route_versions_route_version_unique" UNIQUE("route_id","version"),
	CONSTRAINT "experimental_route_versions_kind_check" CHECK (kind in ('baseline', 'candidate'))
);
--> statement-breakpoint
CREATE TABLE "experimental_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"current_version" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experimental_routes_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "forgetting_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"impact" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "forgetting_requests_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "forgetting_requests_status_check" CHECK (status in ('requested', 'approved', 'completed', 'rejected', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "lineage_edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_type" text NOT NULL,
	"from_id" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lineage_edges_identity_unique" UNIQUE("from_type","from_id","to_type","to_id","relation"),
	CONSTRAINT "lineage_edges_relation_check" CHECK (relation in ('definitely_used', 'potentially_used', 'not_used'))
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"scope" text,
	"provenance" text,
	"max_age_days" integer,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_name_version_unique" UNIQUE("name","version"),
	CONSTRAINT "retention_policies_status_check" CHECK (status in ('published'))
);
--> statement-breakpoint
CREATE TABLE "rollback_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"route_id" uuid NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"error" text,
	"verification" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "rollback_requests_status_check" CHECK (status in ('requested', 'approved', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_status_check";--> statement-breakpoint
ALTER TABLE "model_candidates" DROP CONSTRAINT "model_candidates_status_check";--> statement-breakpoint
ALTER TABLE "artifact_contamination" ADD CONSTRAINT "artifact_contamination_artifact_id_training_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."training_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_contamination" ADD CONSTRAINT "artifact_contamination_forgetting_request_id_forgetting_requests_id_fk" FOREIGN KEY ("forgetting_request_id") REFERENCES "public"."forgetting_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_items" ADD CONSTRAINT "benchmark_items_version_id_benchmark_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_versions" ADD CONSTRAINT "benchmark_versions_suite_id_benchmark_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."benchmark_suites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_gate_decisions" ADD CONSTRAINT "candidate_gate_decisions_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_gate_decisions" ADD CONSTRAINT "candidate_gate_decisions_report_id_evaluation_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."evaluation_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_item_results" ADD CONSTRAINT "evaluation_item_results_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_benchmark_version_id_benchmark_versions_id_fk" FOREIGN KEY ("benchmark_version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_trainable_model_id_trainable_models_id_fk" FOREIGN KEY ("trainable_model_id") REFERENCES "public"."trainable_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experimental_route_versions" ADD CONSTRAINT "experimental_route_versions_route_id_experimental_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."experimental_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experimental_route_versions" ADD CONSTRAINT "experimental_route_versions_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experimental_route_versions" ADD CONSTRAINT "experimental_route_versions_trainable_model_id_trainable_models_id_fk" FOREIGN KEY ("trainable_model_id") REFERENCES "public"."trainable_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgetting_requests" ADD CONSTRAINT "forgetting_requests_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollback_requests" ADD CONSTRAINT "rollback_requests_route_id_experimental_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."experimental_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_status_check" CHECK ("memories"."status" in ('candidate', 'validated', 'disputed', 'superseded', 'archived', 'expired', 'forgetting_requested', 'forgotten'));--> statement-breakpoint
ALTER TABLE "model_candidates" ADD CONSTRAINT "model_candidates_status_check" CHECK (status in ('experimental', 'rejected', 'approved', 'retired', 'revoked', 'quarantined'));