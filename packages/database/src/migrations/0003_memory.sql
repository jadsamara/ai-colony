CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"category" text NOT NULL,
	"owner_agent_id" uuid,
	"department_id" uuid,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"status" text NOT NULL,
	"quality_score" double precision,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"content_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"superseded_by" uuid,
	"origin_agent_id" uuid,
	"created_by" text NOT NULL,
	"embedding_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "memories_scope_check" CHECK ("memories"."scope" in ('agent', 'department', 'colony')),
	CONSTRAINT "memories_category_check" CHECK ("memories"."category" in ('episodic', 'semantic', 'procedural', 'failure', 'operational')),
	CONSTRAINT "memories_provenance_check" CHECK ("memories"."provenance" in ('model_generated', 'system_observed', 'user_provided', 'externally_verified')),
	CONSTRAINT "memories_status_check" CHECK ("memories"."status" in ('candidate', 'validated', 'disputed', 'superseded', 'archived')),
	CONSTRAINT "memories_scope_owner_check" CHECK (("memories"."scope" = 'agent' and "memories"."owner_agent_id" is not null and "memories"."department_id" is not null) or ("memories"."scope" = 'department' and "memories"."owner_agent_id" is null and "memories"."department_id" is not null) or ("memories"."scope" = 'colony' and "memories"."owner_agent_id" is null and "memories"."department_id" is null))
);
--> statement-breakpoint
CREATE TABLE "memory_consolidation_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"keeper_id" uuid NOT NULL,
	"merged_ids" uuid[] NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_contradictions" (
	"memory_id" uuid NOT NULL,
	"other_memory_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_contradictions_memory_id_other_memory_id_pk" PRIMARY KEY("memory_id","other_memory_id")
);
--> statement-breakpoint
CREATE TABLE "memory_embedding_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"vector_count" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"success" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_promotion_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"from_scope" text NOT NULL,
	"to_scope" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" text NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"created_memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_retrieval_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"objective_id" uuid,
	"task_id" uuid,
	"actor_id" text NOT NULL,
	"query_hash" text NOT NULL,
	"mode" text NOT NULL,
	"hit_count" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_retrieval_hits" (
	"event_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score" double precision NOT NULL,
	CONSTRAINT "memory_retrieval_hits_event_id_memory_id_pk" PRIMARY KEY("event_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_revisions_memory_revision_unique" UNIQUE("memory_id","revision")
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"objective_id" uuid,
	"task_id" uuid,
	"message_id" uuid,
	"source_memory_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_origin_agent_id_agents_id_fk" FOREIGN KEY ("origin_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_consolidation_records" ADD CONSTRAINT "memory_consolidation_records_keeper_id_memories_id_fk" FOREIGN KEY ("keeper_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_contradictions" ADD CONSTRAINT "memory_contradictions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_contradictions" ADD CONSTRAINT "memory_contradictions_other_memory_id_memories_id_fk" FOREIGN KEY ("other_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotion_requests" ADD CONSTRAINT "memory_promotion_requests_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotion_requests" ADD CONSTRAINT "memory_promotion_requests_created_memory_id_memories_id_fk" FOREIGN KEY ("created_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_events" ADD CONSTRAINT "memory_retrieval_events_objective_id_objective_runs_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objective_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_events" ADD CONSTRAINT "memory_retrieval_events_task_id_objective_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."objective_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_hits" ADD CONSTRAINT "memory_retrieval_hits_event_id_memory_retrieval_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."memory_retrieval_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_hits" ADD CONSTRAINT "memory_retrieval_hits_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_objective_id_objective_runs_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objective_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_task_id_objective_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."objective_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_scope_status_idx" ON "memories" USING btree ("scope","status","created_at");--> statement-breakpoint
CREATE INDEX "memories_owner_idx" ON "memories" USING btree ("owner_agent_id");--> statement-breakpoint
CREATE INDEX "memories_department_idx" ON "memories" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "memories_hash_idx" ON "memories" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "memory_sources_objective_idx" ON "memory_sources" USING btree ("objective_id");--> statement-breakpoint
CREATE INDEX "memory_sources_memory_idx" ON "memory_sources" USING btree ("memory_id");