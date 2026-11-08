ALTER TABLE "inference_requests" ALTER COLUMN "objective_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "inference_requests" ADD COLUMN "department_id" uuid;
--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_department_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "inference_requests_department_idx" ON "inference_requests" USING btree ("department_id","created_at");
--> statement-breakpoint
CREATE INDEX "inference_requests_adhoc_idx" ON "inference_requests" USING btree ("created_at") WHERE "objective_id" is null;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "consumed_inference_requests" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "reserved_inference_requests" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "consumed_input_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "consumed_output_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "estimated_input_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "estimated_output_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "reserved_output_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "estimated_cost_usd_micros" bigint;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_inference_counters_check" CHECK (
  "consumed_inference_requests" >= 0
  and "reserved_inference_requests" >= 0
  and "consumed_input_tokens" >= 0
  and "consumed_output_tokens" >= 0
  and "estimated_input_tokens" >= 0
  and "estimated_output_tokens" >= 0
  and "reserved_output_tokens" >= 0
);
