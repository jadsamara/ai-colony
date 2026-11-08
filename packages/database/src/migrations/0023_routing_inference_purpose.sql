ALTER TABLE "inference_requests" DROP CONSTRAINT "inference_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_purpose_check" CHECK ("purpose" in ('plan', 'correct', 'specialist', 'synthesize', 'monitor', 'routing'));
