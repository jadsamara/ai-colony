CREATE TABLE "agent_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_lifecycle_events_from_check" CHECK (from_status in ('registered', 'initializing', 'idle', 'running', 'paused', 'stopping', 'stopped', 'failed', 'archived')),
	CONSTRAINT "agent_lifecycle_events_to_check" CHECK (to_status in ('registered', 'initializing', 'idle', 'running', 'paused', 'stopping', 'stopped', 'failed', 'archived')),
	CONSTRAINT "agent_lifecycle_events_actor_check" CHECK (actor_type in ('system', 'human', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role_name" text NOT NULL,
	"description" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"model_id" uuid,
	"adapter_version" text,
	"memory_namespace" text NOT NULL,
	"compute_budget" jsonb NOT NULL,
	"parameter_budget" jsonb NOT NULL,
	"status" text NOT NULL,
	"performance_metrics" jsonb NOT NULL,
	"parent_agent_id" uuid,
	"specification_version" text NOT NULL,
	"runtime_owner" text,
	"runtime_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_memory_namespace_unique" UNIQUE("memory_namespace"),
	CONSTRAINT "agents_department_name_unique" UNIQUE("department_id","name"),
	CONSTRAINT "agents_status_check" CHECK (status in ('registered', 'initializing', 'idle', 'running', 'paused', 'stopping', 'stopped', 'failed', 'archived')),
	CONSTRAINT "agents_role_check" CHECK (role_name in ('system_administrator', 'ceo_agent', 'orchestration_agent', 'evolution_agent', 'monitoring_agent', 'department_agent', 'read_only_observer')),
	CONSTRAINT "agents_parent_not_self" CHECK ("agents"."parent_agent_id" is null or "agents"."parent_agent_id" <> "agents"."id")
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"approval_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "approval_requests_type_check" CHECK (approval_type in ('department_create', 'department_activate', 'budget_change')),
	CONSTRAINT "approval_requests_target_type_check" CHECK (target_type in ('department', 'agent')),
	CONSTRAINT "approval_requests_status_check" CHECK (status in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"metadata" jsonb NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK (actor_type in ('system', 'human', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"purpose" text NOT NULL,
	"parent_department_id" uuid,
	"status" text NOT NULL,
	"department_type" text NOT NULL,
	"creation_source" text NOT NULL,
	"created_by" text NOT NULL,
	"resource_budget" jsonb NOT NULL,
	"policy_ref" text,
	"metadata" jsonb NOT NULL,
	"specification_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_name_unique" UNIQUE("name"),
	CONSTRAINT "departments_slug_unique" UNIQUE("slug"),
	CONSTRAINT "departments_status_check" CHECK (status in ('proposed', 'provisioning', 'active', 'paused', 'deprecated', 'archived', 'failed')),
	CONSTRAINT "departments_type_check" CHECK (department_type in ('system', 'specialized', 'temporary', 'experimental')),
	CONSTRAINT "departments_creation_source_check" CHECK (creation_source in ('seed', 'api')),
	CONSTRAINT "departments_parent_not_self" CHECK ("departments"."parent_department_id" is null or "departments"."parent_department_id" <> "departments"."id")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lineage_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"display_name" text NOT NULL,
	"model_family" text NOT NULL,
	"provider" text NOT NULL,
	"parameter_count" bigint NOT NULL,
	"model_type" text NOT NULL,
	"artifact_uri" text,
	"deployment_target" text NOT NULL,
	"status" text NOT NULL,
	"quantization" text,
	"context_window" integer,
	"capabilities" jsonb NOT NULL,
	"trainable" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_lineage_version_unique" UNIQUE("lineage_id","version"),
	CONSTRAINT "models_status_check" CHECK (status in ('registered', 'not_deployed', 'deploying', 'available', 'unavailable', 'deprecated')),
	CONSTRAINT "models_deployment_target_check" CHECK (deployment_target in ('none', 'local', 'cloud-run', 'external')),
	CONSTRAINT "models_quantization_check" CHECK ("models"."quantization" is null or quantization in ('none', 'int8', 'int4', 'fp8', 'fp16', 'bf16', 'fp32')),
	CONSTRAINT "models_parameter_count_check" CHECK ("models"."parameter_count" >= 0),
	CONSTRAINT "models_version_check" CHECK ("models"."version" >= 1),
	CONSTRAINT "models_context_window_check" CHECK ("models"."context_window" is null or ("models"."context_window" > 0 and "models"."context_window" <= 10000000))
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_type" text NOT NULL,
	"display_name" text NOT NULL,
	"role_name" text NOT NULL,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_agent_id_unique" UNIQUE("agent_id"),
	CONSTRAINT "principals_type_check" CHECK (principal_type in ('system', 'human', 'agent')),
	CONSTRAINT "principals_role_check" CHECK (role_name in ('system_administrator', 'ceo_agent', 'orchestration_agent', 'evolution_agent', 'monitoring_agent', 'department_agent', 'read_only_observer'))
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_name" text NOT NULL,
	"permission_name" text NOT NULL,
	CONSTRAINT "role_permissions_role_name_permission_name_pk" PRIMARY KEY("role_name","permission_name")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_lifecycle_events" ADD CONSTRAINT "agent_lifecycle_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_principals_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_principals_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_department_id_departments_id_fk" FOREIGN KEY ("parent_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_name_roles_name_fk" FOREIGN KEY ("role_name") REFERENCES "public"."roles"("name") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_name_permissions_name_fk" FOREIGN KEY ("permission_name") REFERENCES "public"."permissions"("name") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_lifecycle_events_agent_idx" ON "agent_lifecycle_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agents_department_id_idx" ON "agents" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agents_parent_agent_id_idx" ON "agents" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE INDEX "agents_runtime_status_idx" ON "agents" USING btree ("status","runtime_heartbeat_at");--> statement-breakpoint
CREATE INDEX "agents_created_at_id_idx" ON "agents" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "approval_requests_target_idx" ON "approval_requests" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approval_requests_created_at_id_idx" ON "approval_requests" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending_idx" ON "approval_requests" USING btree ("approval_type","target_type","target_id") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at","event_id");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "departments_parent_idx" ON "departments" USING btree ("parent_department_id");--> statement-breakpoint
CREATE INDEX "departments_status_idx" ON "departments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "departments_created_at_id_idx" ON "departments" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "models_lineage_id_idx" ON "models" USING btree ("lineage_id");--> statement-breakpoint
CREATE INDEX "models_status_idx" ON "models" USING btree ("status");--> statement-breakpoint
CREATE INDEX "models_created_at_id_idx" ON "models" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "principals_role_name_idx" ON "principals" USING btree ("role_name");