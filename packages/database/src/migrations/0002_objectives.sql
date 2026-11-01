CREATE TABLE "inference_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"objective_id" uuid NOT NULL,
	"task_id" uuid,
	"attempt" integer NOT NULL,
	"purpose" text NOT NULL,
	"registry_model_id" uuid NOT NULL,
	"intended_model_id" uuid NOT NULL,
	"requested_alias" text NOT NULL,
	"status" text NOT NULL,
	"reserved_output_tokens" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"response_text" text,
	"error" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "inference_requests_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "inference_requests_status_check" CHECK (status in ('reserved', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "inference_requests_purpose_check" CHECK ("inference_requests"."purpose" in ('plan', 'correct', 'specialist', 'synthesize', 'monitor'))
);
--> statement-breakpoint
CREATE TABLE "inference_usage" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"token_source" text NOT NULL,
	"served_model" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"estimated_cost_usd_micros" bigint,
	"override_applied" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_usage_source_check" CHECK ("inference_usage"."token_source" in ('observed', 'unavailable', 'estimated'))
);
--> statement-breakpoint
CREATE TABLE "model_runtimes" (
	"model_id" uuid PRIMARY KEY NOT NULL,
	"runtime_status" text NOT NULL,
	"endpoint_url" text,
	"expected_alias" text,
	"loaded_model_id" text,
	"last_error" text,
	"probed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_runtimes_status_check" CHECK ("model_runtimes"."runtime_status" in ('not_deployed', 'loading', 'ready', 'unavailable', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "objective_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"objective_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"valid" boolean NOT NULL,
	"errors" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "objective_plans_version_unique" UNIQUE("objective_id","version")
);
--> statement-breakpoint
CREATE TABLE "objective_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submitter_principal_id" uuid NOT NULL,
	"objective_text" text NOT NULL,
	"status" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"failure_reason" text,
	"final_output" text,
	"execution_authorized" boolean NOT NULL,
	"plan_corrections" integer DEFAULT 0 NOT NULL,
	"memory_profile" text NOT NULL,
	"primary_model_id" uuid NOT NULL,
	"operational_model_id" uuid,
	"max_inference_requests" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"max_estimated_tokens" integer NOT NULL,
	"max_task_attempts" integer NOT NULL,
	"max_concurrent_tasks" integer NOT NULL,
	"max_duration_ms" integer NOT NULL,
	"consumed_requests" integer DEFAULT 0 NOT NULL,
	"reserved_requests" integer DEFAULT 0 NOT NULL,
	"consumed_input_tokens" integer DEFAULT 0 NOT NULL,
	"consumed_output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_input_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_output_tokens" integer DEFAULT 0 NOT NULL,
	"reserved_output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "objective_runs_status_check" CHECK (status in ('submitted', 'planning', 'awaiting_approval', 'scheduled', 'running', 'synthesizing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "objective_runs_profile_check" CHECK ("objective_runs"."memory_profile" in ('shared', 'split')),
	CONSTRAINT "objective_runs_limits_check" CHECK ("objective_runs"."max_inference_requests" > 0)
);
--> statement-breakpoint
CREATE TABLE "objective_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"objective_id" uuid NOT NULL,
	"local_id" text NOT NULL,
	"department_id" uuid NOT NULL,
	"department_slug" text NOT NULL,
	"task_type" text NOT NULL,
	"objective_text" text NOT NULL,
	"expected_output" text NOT NULL,
	"depends_on" uuid[] NOT NULL,
	"status" text NOT NULL,
	"attempt" integer NOT NULL,
	"assigned_agent_id" uuid,
	"request_message_id" uuid,
	"error" text,
	"result_summary" text,
	"deadline" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "objective_tasks_local_unique" UNIQUE("objective_id","local_id"),
	CONSTRAINT "objective_tasks_status_check" CHECK (status in ('pending', 'ready', 'dispatched', 'running', 'completed', 'failed', 'timed_out', 'cancelled')),
	CONSTRAINT "objective_tasks_type_check" CHECK (task_type in ('math', 'science', 'research', 'reasoning')),
	CONSTRAINT "objective_tasks_attempt_check" CHECK ("objective_tasks"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "task_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_results_attempt_unique" UNIQUE("task_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"objective_id" uuid,
	"event_type" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_objective_id_objective_runs_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objective_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_task_id_objective_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."objective_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_registry_model_id_models_id_fk" FOREIGN KEY ("registry_model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_intended_model_id_models_id_fk" FOREIGN KEY ("intended_model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage" ADD CONSTRAINT "inference_usage_request_id_inference_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."inference_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_runtimes" ADD CONSTRAINT "model_runtimes_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_plans" ADD CONSTRAINT "objective_plans_objective_id_objective_runs_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objective_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_runs" ADD CONSTRAINT "objective_runs_submitter_principal_id_principals_id_fk" FOREIGN KEY ("submitter_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_runs" ADD CONSTRAINT "objective_runs_primary_model_id_models_id_fk" FOREIGN KEY ("primary_model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_runs" ADD CONSTRAINT "objective_runs_operational_model_id_models_id_fk" FOREIGN KEY ("operational_model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_tasks" ADD CONSTRAINT "objective_tasks_objective_id_objective_runs_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objective_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_tasks" ADD CONSTRAINT "objective_tasks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_tasks" ADD CONSTRAINT "objective_tasks_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_task_id_objective_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."objective_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_results" ADD CONSTRAINT "task_results_task_id_objective_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."objective_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_objective_id_objective_runs_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objective_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_requests_objective_idx" ON "inference_requests" USING btree ("objective_id","created_at");--> statement-breakpoint
CREATE INDEX "objective_plans_objective_idx" ON "objective_plans" USING btree ("objective_id","version");--> statement-breakpoint
CREATE INDEX "objective_runs_status_idx" ON "objective_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "objective_runs_submitter_idx" ON "objective_runs" USING btree ("submitter_principal_id","created_at");--> statement-breakpoint
CREATE INDEX "objective_tasks_status_idx" ON "objective_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "objective_tasks_objective_idx" ON "objective_tasks" USING btree ("objective_id");--> statement-breakpoint
CREATE INDEX "task_assignments_task_idx" ON "task_assignments" USING btree ("task_id","attempt");--> statement-breakpoint
CREATE INDEX "workflow_events_objective_idx" ON "workflow_events" USING btree ("objective_id","created_at");