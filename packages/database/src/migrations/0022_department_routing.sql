CREATE TABLE "department_routing_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"task_text" text NOT NULL,
	"objective_id" uuid,
	"method" text NOT NULL,
	"primary_department_id" uuid NOT NULL,
	"recommended_department_ids" jsonb NOT NULL,
	"rejected_recommendations" jsonb NOT NULL,
	"final_participant_ids" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"confidence" text NOT NULL,
	"uncertainty" text,
	"approval_required" boolean DEFAULT false NOT NULL,
	"model_metadata" jsonb,
	"fallback_reason" text,
	"created_by" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "department_routing_decisions" ADD CONSTRAINT "department_routing_decisions_objective_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objective_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "department_routing_decisions" ADD CONSTRAINT "department_routing_decisions_primary_fk" FOREIGN KEY ("primary_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "department_routing_decisions_idempotency_unique" ON "department_routing_decisions" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "department_routing_decisions_created_idx" ON "department_routing_decisions" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "department_routing_decisions_method_idx" ON "department_routing_decisions" USING btree ("method","created_at");
--> statement-breakpoint
ALTER TABLE "department_routing_decisions" ADD CONSTRAINT "department_routing_decisions_method_check" CHECK ("method" in ('deterministic', 'model_assisted', 'fallback'));
--> statement-breakpoint
ALTER TABLE "department_routing_decisions" ADD CONSTRAINT "department_routing_decisions_confidence_check" CHECK ("confidence" in ('high', 'medium', 'low'));
