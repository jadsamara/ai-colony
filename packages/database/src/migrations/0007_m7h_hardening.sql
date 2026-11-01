CREATE TABLE "collaboration_contexts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classification" text NOT NULL,
	"owner_department_id" uuid NOT NULL,
	"status" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "collaboration_contexts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "collaboration_contexts_class_check" CHECK (classification in ('consultation', 'specialist', 'joint')),
	CONSTRAINT "collaboration_contexts_status_check" CHECK (status in ('open', 'closed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "collaboration_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"context_id" uuid NOT NULL,
	"author_department_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"promoted_memory_id" uuid,
	"source_memory_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_entries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "collaboration_entries_kind_check" CHECK (kind in ('request_context', 'answer', 'contribution', 'shared_decision')),
	CONSTRAINT "collaboration_entries_status_check" CHECK (status in ('active', 'expired', 'archived', 'promoted')),
	CONSTRAINT "collaboration_entries_provenance_check" CHECK ("collaboration_entries"."provenance" in ('model_generated', 'system_observed', 'user_provided', 'externally_verified'))
);
--> statement-breakpoint
CREATE TABLE "collaboration_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"context_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_participants_context_department_unique" UNIQUE("context_id","department_id"),
	CONSTRAINT "collaboration_participants_role_check" CHECK (role in ('owner', 'contributor')),
	CONSTRAINT "collaboration_participants_status_check" CHECK (status in ('invited', 'active', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "deployment_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cycle_id" uuid NOT NULL,
	"improvement_decision_id" uuid,
	"purpose" text NOT NULL,
	"eligibility" text NOT NULL,
	"adopted" boolean NOT NULL,
	"rationale" text NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_decisions_cycle_purpose_unique" UNIQUE("cycle_id","purpose"),
	CONSTRAINT "deployment_decisions_purpose_check" CHECK (purpose in ('improvement', 'exceptional')),
	CONSTRAINT "deployment_decisions_eligibility_check" CHECK (eligibility in ('eligible', 'ineligible', 'exceptional'))
);
--> statement-breakpoint
CREATE TABLE "improvement_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"evaluation_run_id" uuid,
	"cycle_id" uuid,
	"policy_version" text NOT NULL,
	"policy_hash" text NOT NULL,
	"safety_gate" text NOT NULL,
	"safety_gate_version" text NOT NULL,
	"classification" text NOT NULL,
	"deployment_eligibility" text NOT NULL,
	"baseline_ref" text,
	"candidate_id" uuid,
	"sample_count" integer NOT NULL,
	"effect_size" double precision NOT NULL,
	"uncertainty" jsonb NOT NULL,
	"retention" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "improvement_decisions_class_check" CHECK (classification in ('VERIFIED_IMPROVEMENT', 'NO_VERIFIED_IMPROVEMENT', 'VERIFIED_REGRESSION', 'INCONCLUSIVE', 'EVALUATION_INVALID')),
	CONSTRAINT "improvement_decisions_eligibility_check" CHECK (deployment_eligibility in ('eligible', 'ineligible', 'exceptional'))
);
--> statement-breakpoint
CREATE TABLE "memory_ownership" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"originating_department_id" uuid,
	"primary_owner_department_id" uuid NOT NULL,
	"recipient_department_id" uuid,
	"classification" text NOT NULL,
	"collaboration_id" uuid,
	"retention_policy" text NOT NULL,
	"promotion_reason" text NOT NULL,
	"validation_status" text NOT NULL,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_ownership_class_check" CHECK (classification in ('consultation', 'specialist', 'joint')),
	CONSTRAINT "memory_ownership_validation_check" CHECK (validation_status in ('validated', 'unverified'))
);
--> statement-breakpoint
ALTER TABLE "collaboration_contexts" ADD CONSTRAINT "collaboration_contexts_owner_department_id_departments_id_fk" FOREIGN KEY ("owner_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_entries" ADD CONSTRAINT "collaboration_entries_context_id_collaboration_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."collaboration_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_entries" ADD CONSTRAINT "collaboration_entries_author_department_id_departments_id_fk" FOREIGN KEY ("author_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_entries" ADD CONSTRAINT "collaboration_entries_promoted_memory_id_memories_id_fk" FOREIGN KEY ("promoted_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_entries" ADD CONSTRAINT "collaboration_entries_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_context_id_collaboration_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."collaboration_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_decisions" ADD CONSTRAINT "deployment_decisions_cycle_id_learning_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."learning_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_decisions" ADD CONSTRAINT "deployment_decisions_improvement_decision_id_improvement_decisions_id_fk" FOREIGN KEY ("improvement_decision_id") REFERENCES "public"."improvement_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_decisions" ADD CONSTRAINT "improvement_decisions_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_decisions" ADD CONSTRAINT "improvement_decisions_cycle_id_learning_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."learning_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_decisions" ADD CONSTRAINT "improvement_decisions_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_ownership" ADD CONSTRAINT "memory_ownership_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_ownership" ADD CONSTRAINT "memory_ownership_originating_department_id_departments_id_fk" FOREIGN KEY ("originating_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_ownership" ADD CONSTRAINT "memory_ownership_primary_owner_department_id_departments_id_fk" FOREIGN KEY ("primary_owner_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_ownership" ADD CONSTRAINT "memory_ownership_recipient_department_id_departments_id_fk" FOREIGN KEY ("recipient_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_ownership" ADD CONSTRAINT "memory_ownership_collaboration_id_collaboration_contexts_id_fk" FOREIGN KEY ("collaboration_id") REFERENCES "public"."collaboration_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_ownership" ADD CONSTRAINT "memory_ownership_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collaboration_entries_context_idx" ON "collaboration_entries" USING btree ("context_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "improvement_decisions_run_policy_unique" ON "improvement_decisions" USING btree ("evaluation_run_id","policy_version") WHERE "improvement_decisions"."evaluation_run_id" is not null;