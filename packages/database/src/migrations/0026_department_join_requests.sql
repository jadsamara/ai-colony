ALTER TABLE "inference_requests" DROP CONSTRAINT "inference_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_purpose_check" CHECK ("purpose" in ('plan', 'correct', 'specialist', 'synthesize', 'monitor', 'routing', 'join_approval'));
--> statement-breakpoint
CREATE TABLE "department_join_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requester_department_id" uuid NOT NULL,
	"target_department_id" uuid NOT NULL,
	"justification" text NOT NULL,
	"status" text NOT NULL,
	"decision_rationale" text,
	"confidence" text,
	"task_brief" text,
	"inference_request_id" uuid,
	"model_metadata" jsonb,
	"failure_reason" text,
	"created_by" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "department_join_requests" ADD CONSTRAINT "department_join_requests_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."department_conversations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "department_join_requests" ADD CONSTRAINT "department_join_requests_requester_fk" FOREIGN KEY ("requester_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "department_join_requests" ADD CONSTRAINT "department_join_requests_target_fk" FOREIGN KEY ("target_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "department_join_requests" ADD CONSTRAINT "department_join_requests_inference_fk" FOREIGN KEY ("inference_request_id") REFERENCES "public"."inference_requests"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "department_join_requests_idempotency_unique" ON "department_join_requests" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "department_join_requests_conversation_idx" ON "department_join_requests" USING btree ("conversation_id", "created_at");
--> statement-breakpoint
CREATE INDEX "department_join_requests_status_idx" ON "department_join_requests" USING btree ("status", "created_at");
--> statement-breakpoint
ALTER TABLE "department_join_requests" ADD CONSTRAINT "department_join_requests_status_check" CHECK ("status" in ('pending', 'approved', 'rejected', 'failed'));
--> statement-breakpoint
ALTER TABLE "department_join_requests" ADD CONSTRAINT "department_join_requests_confidence_check" CHECK ("confidence" is null or "confidence" in ('high', 'medium', 'low'));
