ALTER TABLE "colony_autonomy" ADD COLUMN "max_inference_output_tokens" integer DEFAULT 4000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD COLUMN "max_inference_estimated_tokens" integer DEFAULT 32000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "colony_autonomy" ADD CONSTRAINT "colony_autonomy_inference_token_limits_check" CHECK (
  "max_inference_output_tokens" > 0
  and "max_inference_estimated_tokens" > 0
  and "max_inference_estimated_tokens" >= "max_inference_output_tokens"
);
