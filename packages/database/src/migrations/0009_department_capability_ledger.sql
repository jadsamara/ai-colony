CREATE TABLE "ledger_topics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"provenance" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "ledger_topic_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"name" text,
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_topic_events_type_check" CHECK ("event_type" in ('rename', 'describe', 'deprecate'))
);

CREATE TABLE "ledger_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"proposed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_proposals_kind_check" CHECK ("kind" in ('taxonomy', 'mapping'))
);

CREATE TABLE "ledger_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_decisions_proposal_unique" UNIQUE("proposal_id"),
	CONSTRAINT "ledger_decisions_decision_check" CHECK ("decision" in ('approved', 'rejected'))
);

CREATE TABLE "ledger_taxonomy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"proposal_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_taxonomy_versions_unique" UNIQUE("department_id", "version")
);

CREATE TABLE "ledger_taxonomy_edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"parent_topic_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"target_department_id" uuid,
	CONSTRAINT "ledger_taxonomy_edges_kind_check" CHECK ("kind" in ('parent', 'cross_link')),
	CONSTRAINT "ledger_taxonomy_edges_status_check" CHECK ("status" in ('active', 'deprecated')),
	CONSTRAINT "ledger_taxonomy_edges_not_self" CHECK ("parent_topic_id" is null or "parent_topic_id" <> "topic_id"),
	CONSTRAINT "ledger_taxonomy_edges_shape_check" CHECK (
		("kind" = 'parent' AND "target_department_id" is null)
		OR ("kind" = 'cross_link' AND "parent_topic_id" is not null)
	)
);

CREATE UNIQUE INDEX "ledger_edge_one_parent" ON "ledger_taxonomy_edges" ("version_id", "topic_id") WHERE "kind" = 'parent';
CREATE UNIQUE INDEX "ledger_edge_cross_link" ON "ledger_taxonomy_edges" ("version_id", "topic_id", "parent_topic_id") WHERE "kind" = 'cross_link';

CREATE TABLE "ledger_mapping_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_mapping_versions_unique" UNIQUE("department_id", "version")
);

CREATE TABLE "ledger_topic_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mapping_version_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"topic_id" uuid NOT NULL,
	"weight" double precision,
	"provenance" text NOT NULL,
	CONSTRAINT "ledger_topic_mappings_item_topic_unique" UNIQUE("mapping_version_id", "item_id", "topic_id"),
	CONSTRAINT "ledger_topic_mappings_digest_check" CHECK ("content_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ledger_topic_mappings_weight_check" CHECK ("weight" is null or ("weight" > 0 AND "weight" <= 1))
);

CREATE TABLE "ledger_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"mapping_version_id" uuid NOT NULL,
	"evaluation_run_id" uuid,
	"evidence_ref" text NOT NULL,
	"manifest_fingerprint" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"model_family" text,
	"model_identifier" text,
	"checkpoint_digest" text,
	"adapter_id" text,
	"adapter_digest" text,
	"measured_at" timestamp with time zone NOT NULL,
	"validity" text NOT NULL,
	"sample_size" integer NOT NULL,
	"correct_count" integer NOT NULL,
	"incorrect_count" integer NOT NULL,
	"failure_classes" jsonb NOT NULL,
	"accuracy" double precision NOT NULL,
	"uncertainty_low" double precision NOT NULL,
	"uncertainty_high" double precision NOT NULL,
	"measurement_mode" text NOT NULL,
	"capability_kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"provenance" text NOT NULL,
	"schema_version" text NOT NULL,
	"certified_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_snapshots_validity_check" CHECK ("validity" in ('valid', 'invalid', 'incomplete')),
	CONSTRAINT "ledger_snapshots_mode_check" CHECK ("measurement_mode" in ('closed_book', 'retrieval_assisted')),
	CONSTRAINT "ledger_snapshots_kind_check" CHECK ("capability_kind" in ('model', 'agent_system')),
	CONSTRAINT "ledger_snapshots_counts_check" CHECK (
		"sample_size" > 0
		AND "correct_count" >= 0
		AND "incorrect_count" >= 0
		AND "correct_count" + "incorrect_count" = "sample_size"
		AND "accuracy" >= 0
		AND "accuracy" <= 1
	)
);

CREATE TABLE "ledger_retention_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"action" text NOT NULL,
	"decided_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_retention_events_action_check" CHECK ("action" in ('retain', 'revoke', 'archive'))
);

ALTER TABLE "ledger_topics" ADD CONSTRAINT "ledger_topics_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_topic_events" ADD CONSTRAINT "ledger_topic_events_topic_id_ledger_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."ledger_topics"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_proposals" ADD CONSTRAINT "ledger_proposals_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_decisions" ADD CONSTRAINT "ledger_decisions_proposal_id_ledger_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."ledger_proposals"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_taxonomy_versions" ADD CONSTRAINT "ledger_taxonomy_versions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_taxonomy_versions" ADD CONSTRAINT "ledger_taxonomy_versions_proposal_id_ledger_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."ledger_proposals"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_taxonomy_edges" ADD CONSTRAINT "ledger_taxonomy_edges_version_id_ledger_taxonomy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."ledger_taxonomy_versions"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_taxonomy_edges" ADD CONSTRAINT "ledger_taxonomy_edges_topic_id_ledger_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."ledger_topics"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_taxonomy_edges" ADD CONSTRAINT "ledger_taxonomy_edges_parent_topic_id_ledger_topics_id_fk" FOREIGN KEY ("parent_topic_id") REFERENCES "public"."ledger_topics"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_taxonomy_edges" ADD CONSTRAINT "ledger_taxonomy_edges_target_department_id_departments_id_fk" FOREIGN KEY ("target_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_mapping_versions" ADD CONSTRAINT "ledger_mapping_versions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_mapping_versions" ADD CONSTRAINT "ledger_mapping_versions_taxonomy_version_id_ledger_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."ledger_taxonomy_versions"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_mapping_versions" ADD CONSTRAINT "ledger_mapping_versions_proposal_id_ledger_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."ledger_proposals"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_topic_mappings" ADD CONSTRAINT "ledger_topic_mappings_mapping_version_id_ledger_mapping_versions_id_fk" FOREIGN KEY ("mapping_version_id") REFERENCES "public"."ledger_mapping_versions"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_topic_mappings" ADD CONSTRAINT "ledger_topic_mappings_topic_id_ledger_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."ledger_topics"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_snapshots" ADD CONSTRAINT "ledger_snapshots_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_snapshots" ADD CONSTRAINT "ledger_snapshots_topic_id_ledger_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."ledger_topics"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_snapshots" ADD CONSTRAINT "ledger_snapshots_taxonomy_version_id_ledger_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."ledger_taxonomy_versions"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_snapshots" ADD CONSTRAINT "ledger_snapshots_mapping_version_id_ledger_mapping_versions_id_fk" FOREIGN KEY ("mapping_version_id") REFERENCES "public"."ledger_mapping_versions"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_snapshots" ADD CONSTRAINT "ledger_snapshots_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "ledger_retention_events" ADD CONSTRAINT "ledger_retention_events_snapshot_id_ledger_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."ledger_snapshots"("id") ON DELETE restrict ON UPDATE no action;
