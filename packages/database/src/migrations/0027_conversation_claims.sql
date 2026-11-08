CREATE TABLE "conversation_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"proposing_department_id" uuid NOT NULL,
	"supporting_turn_id" uuid,
	"claim_text" text NOT NULL,
	"provenance" text NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verifier_id" text,
	"verification_method" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_claim_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claim_id" uuid NOT NULL,
	"method" text NOT NULL,
	"verdict" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"units" jsonb NOT NULL,
	"tolerance" jsonb,
	"diagnostic" text,
	"computed_value" double precision,
	"claimed_value" double precision,
	"verifier_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_claims" ADD CONSTRAINT "conversation_claims_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."department_conversations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_claims" ADD CONSTRAINT "conversation_claims_department_fk" FOREIGN KEY ("proposing_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_claims" ADD CONSTRAINT "conversation_claims_turn_fk" FOREIGN KEY ("supporting_turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_claim_verifications" ADD CONSTRAINT "conversation_claim_verifications_claim_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."conversation_claims"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_claims_conversation_idx" ON "conversation_claims" USING btree ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX "conversation_claims_status_idx" ON "conversation_claims" USING btree ("verification_status","created_at");
--> statement-breakpoint
CREATE INDEX "conversation_claim_verifications_claim_idx" ON "conversation_claim_verifications" USING btree ("claim_id","created_at");
--> statement-breakpoint
ALTER TABLE "conversation_claims" ADD CONSTRAINT "conversation_claims_status_check" CHECK ("verification_status" in ('unverified', 'verified', 'refuted', 'inconclusive'));
--> statement-breakpoint
ALTER TABLE "conversation_claims" ADD CONSTRAINT "conversation_claims_provenance_check" CHECK ("provenance" in ('model_turn', 'human', 'system', 'evaluation'));
--> statement-breakpoint
ALTER TABLE "conversation_claims" ADD CONSTRAINT "conversation_claims_revision_check" CHECK ("revision" >= 1);
--> statement-breakpoint
ALTER TABLE "conversation_claim_verifications" ADD CONSTRAINT "conversation_claim_verifications_verdict_check" CHECK ("verdict" in ('unverified', 'verified', 'refuted', 'inconclusive'));
