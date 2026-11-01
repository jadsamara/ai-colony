CREATE TABLE "capability_gaps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"capability_id" uuid,
	"task_category" text NOT NULL,
	"fingerprint" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"failure_count" integer NOT NULL,
	"severity" text NOT NULL,
	"impact" text NOT NULL,
	"baseline" jsonb NOT NULL,
	"proposed_method" text NOT NULL,
	"resources" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_gaps_fingerprint_unique" UNIQUE("department_id","fingerprint"),
	CONSTRAINT "capability_gaps_status_check" CHECK (status in ('observed', 'validated', 'rejected', 'aggregated')),
	CONSTRAINT "capability_gaps_method_check" CHECK (proposed_method in ('memory_acquisition', 'memory_consolidation', 'workflow', 'retrieval', 'lora', 'knowledge_transfer', 'no_action')),
	CONSTRAINT "capability_gaps_severity_check" CHECK (severity in ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "department_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"domain" text NOT NULL,
	"task_type" text NOT NULL,
	"description" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_capabilities_slug_unique" UNIQUE("department_id","slug")
);
--> statement-breakpoint
CREATE TABLE "department_capability_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"capability_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"tool_names" jsonb NOT NULL,
	"required_permissions" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"evaluation_run_id" uuid,
	"benchmark_version_id" uuid,
	"reliability" jsonb NOT NULL,
	"resources" jsonb NOT NULL,
	"improvement_kind" text NOT NULL,
	"approved_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_capability_versions_unique" UNIQUE("capability_id","version"),
	CONSTRAINT "department_capability_versions_status_check" CHECK (status in ('proposed', 'experimental', 'evaluated', 'approved', 'rejected', 'revoked', 'superseded')),
	CONSTRAINT "department_capability_versions_kind_check" CHECK (improvement_kind in ('MEMORY_IMPROVEMENT', 'RETRIEVAL_IMPROVEMENT', 'WORKFLOW_IMPROVEMENT', 'TOOL_IMPROVEMENT', 'MODEL_WEIGHT_IMPROVEMENT', 'NO_VERIFIED_IMPROVEMENT'))
);
--> statement-breakpoint
CREATE TABLE "department_model_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"role" text NOT NULL,
	"registry_model_id" uuid NOT NULL,
	"trainable_model_id" uuid,
	"candidate_id" uuid,
	"adapter_sha256" text,
	"model_family" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_model_assignments_version_unique" UNIQUE("department_id","version"),
	CONSTRAINT "department_model_assignments_role_check" CHECK (role in ('shared_base', 'experimental_adapter', 'capability_adapter', 'fallback')),
	CONSTRAINT "department_model_assignments_status_check" CHECK (status in ('active', 'superseded', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_department_id" uuid NOT NULL,
	"destination_department_id" uuid NOT NULL,
	"source_memory_id" uuid,
	"summary" text NOT NULL,
	"provenance" text NOT NULL,
	"trust" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"restrictions" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"cycle_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_transfers_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "knowledge_transfers_status_check" CHECK (status in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_validations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transfer_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_by" text NOT NULL,
	"reason" text NOT NULL,
	"accepted_memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_validations_transfer_id_unique" UNIQUE("transfer_id"),
	CONSTRAINT "knowledge_validations_decision_check" CHECK (decision in ('accept', 'reject'))
);
--> statement-breakpoint
CREATE TABLE "learning_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cycle_id" uuid NOT NULL,
	"max_inference_calls" integer NOT NULL,
	"max_training_steps" integer NOT NULL,
	"max_runtime_ms" integer NOT NULL,
	"used_inference_calls" integer NOT NULL,
	"used_training_steps" integer NOT NULL,
	"used_runtime_ms" integer NOT NULL,
	CONSTRAINT "learning_budgets_cycle_id_unique" UNIQUE("cycle_id")
);
--> statement-breakpoint
CREATE TABLE "learning_cycle_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cycle_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_cycles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"objective_id" uuid,
	"department_id" uuid NOT NULL,
	"status" text NOT NULL,
	"method" text NOT NULL,
	"outcome_kind" text,
	"training_run_id" uuid,
	"evaluation_run_id" uuid,
	"gate_decision" text,
	"transfer_id" uuid,
	"memory_id" uuid,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_cycles_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "learning_cycles_status_check" CHECK (status in ('OBSERVED', 'GAP_VALIDATED', 'OBJECTIVE_CREATED', 'METHOD_SELECTED', 'PROPOSAL_PENDING', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'EVALUATING', 'AWAITING_PROMOTION', 'ADOPTED', 'REJECTED', 'INCONCLUSIVE', 'FAILED', 'CANCELLED')),
	CONSTRAINT "learning_cycles_method_check" CHECK (method in ('memory_acquisition', 'memory_consolidation', 'workflow', 'retrieval', 'lora', 'knowledge_transfer', 'no_action'))
);
--> statement-breakpoint
CREATE TABLE "learning_objectives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"gap_id" uuid NOT NULL,
	"capability_id" uuid,
	"version" integer NOT NULL,
	"weakness" text NOT NULL,
	"mechanism" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"benchmark_version_id" uuid,
	"baseline_ref" text,
	"budget" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_objectives_version_unique" UNIQUE("gap_id","version"),
	CONSTRAINT "learning_objectives_mechanism_check" CHECK (mechanism in ('memory_acquisition', 'memory_consolidation', 'workflow', 'retrieval', 'lora', 'knowledge_transfer', 'no_action'))
);
--> statement-breakpoint
CREATE TABLE "learning_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cycle_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"verified" boolean NOT NULL,
	"summary" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_outcomes_cycle_id_unique" UNIQUE("cycle_id"),
	CONSTRAINT "learning_outcomes_kind_check" CHECK (kind in ('MEMORY_IMPROVEMENT', 'RETRIEVAL_IMPROVEMENT', 'WORKFLOW_IMPROVEMENT', 'TOOL_IMPROVEMENT', 'MODEL_WEIGHT_IMPROVEMENT', 'NO_VERIFIED_IMPROVEMENT'))
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_type_check";--> statement-breakpoint
ALTER TABLE "capability_gaps" ADD CONSTRAINT "capability_gaps_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_gaps" ADD CONSTRAINT "capability_gaps_capability_id_department_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."department_capabilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_capabilities" ADD CONSTRAINT "department_capabilities_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_capability_versions" ADD CONSTRAINT "department_capability_versions_capability_id_department_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."department_capabilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_capability_versions" ADD CONSTRAINT "department_capability_versions_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_capability_versions" ADD CONSTRAINT "department_capability_versions_benchmark_version_id_benchmark_versions_id_fk" FOREIGN KEY ("benchmark_version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_model_assignments" ADD CONSTRAINT "department_model_assignments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_model_assignments" ADD CONSTRAINT "department_model_assignments_registry_model_id_models_id_fk" FOREIGN KEY ("registry_model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_model_assignments" ADD CONSTRAINT "department_model_assignments_trainable_model_id_trainable_models_id_fk" FOREIGN KEY ("trainable_model_id") REFERENCES "public"."trainable_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_model_assignments" ADD CONSTRAINT "department_model_assignments_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_transfers" ADD CONSTRAINT "knowledge_transfers_origin_department_id_departments_id_fk" FOREIGN KEY ("origin_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_transfers" ADD CONSTRAINT "knowledge_transfers_destination_department_id_departments_id_fk" FOREIGN KEY ("destination_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_transfers" ADD CONSTRAINT "knowledge_transfers_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_transfers" ADD CONSTRAINT "knowledge_transfers_cycle_id_learning_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."learning_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_validations" ADD CONSTRAINT "knowledge_validations_transfer_id_knowledge_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."knowledge_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_validations" ADD CONSTRAINT "knowledge_validations_accepted_memory_id_memories_id_fk" FOREIGN KEY ("accepted_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_budgets" ADD CONSTRAINT "learning_budgets_cycle_id_learning_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."learning_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_cycle_events" ADD CONSTRAINT "learning_cycle_events_cycle_id_learning_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."learning_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_cycles" ADD CONSTRAINT "learning_cycles_objective_id_learning_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."learning_objectives"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_cycles" ADD CONSTRAINT "learning_cycles_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_cycles" ADD CONSTRAINT "learning_cycles_training_run_id_training_runs_id_fk" FOREIGN KEY ("training_run_id") REFERENCES "public"."training_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_cycles" ADD CONSTRAINT "learning_cycles_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_cycles" ADD CONSTRAINT "learning_cycles_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_gap_id_capability_gaps_id_fk" FOREIGN KEY ("gap_id") REFERENCES "public"."capability_gaps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_capability_id_department_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."department_capabilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_benchmark_version_id_benchmark_versions_id_fk" FOREIGN KEY ("benchmark_version_id") REFERENCES "public"."benchmark_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_outcomes" ADD CONSTRAINT "learning_outcomes_cycle_id_learning_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."learning_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_cycles_department_idx" ON "learning_cycles" USING btree ("department_id","status");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_type_check" CHECK (message_type in ('TASK_REQUEST', 'TASK_RESULT', 'COLLABORATION_REQUEST', 'KNOWLEDGE_SHARE', 'TRAINING_REQUEST', 'MODEL_CANDIDATE', 'EVALUATION_RESULT', 'RESOURCE_REQUEST', 'HEALTH_ALERT', 'EVOLUTION_PROPOSAL', 'CAPABILITY_GAP', 'LEARNING_OBJECTIVE', 'KNOWLEDGE_TRANSFER', 'KNOWLEDGE_VALIDATION', 'LEARNING_CYCLE_RESULT', 'CAPABILITY_UPDATE'));