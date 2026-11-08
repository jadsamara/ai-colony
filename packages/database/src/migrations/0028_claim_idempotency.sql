ALTER TABLE "conversation_claims" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "conversation_claims" ADD COLUMN "normalized_expression" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_claims_idempotency_unique" ON "conversation_claims" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "conversation_claims_turn_expr_idx" ON "conversation_claims" USING btree ("supporting_turn_id", "normalized_expression");
