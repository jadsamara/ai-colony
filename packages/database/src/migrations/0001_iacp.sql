CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"protocol_version" text NOT NULL,
	"message_type" text NOT NULL,
	"sender_agent_id" uuid NOT NULL,
	"sender_department_id" uuid NOT NULL,
	"recipient_agent_id" uuid,
	"recipient_department_id" uuid,
	"addressing_mode" text NOT NULL,
	"inbox_department_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"reply_to_message_id" uuid,
	"priority" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_schema_version" text NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text,
	"metadata" jsonb NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_type_check" CHECK (message_type in ('TASK_REQUEST', 'TASK_RESULT', 'COLLABORATION_REQUEST', 'KNOWLEDGE_SHARE', 'TRAINING_REQUEST', 'MODEL_CANDIDATE', 'EVALUATION_RESULT', 'RESOURCE_REQUEST', 'HEALTH_ALERT', 'EVOLUTION_PROPOSAL')),
	CONSTRAINT "messages_status_check" CHECK (status in ('accepted', 'published', 'delivered', 'acknowledged', 'rejected', 'expired', 'dead_lettered')),
	CONSTRAINT "messages_addressing_mode_check" CHECK (addressing_mode in ('agent', 'department')),
	CONSTRAINT "messages_protocol_check" CHECK ("messages"."protocol_version" = '1.0'),
	CONSTRAINT "messages_payload_schema_check" CHECK ("messages"."payload_schema_version" = '1.0'),
	CONSTRAINT "messages_priority_check" CHECK ("messages"."priority" between 0 and 9),
	CONSTRAINT "messages_addressing_check" CHECK ((
        ("messages"."addressing_mode" = 'agent' and "messages"."recipient_agent_id" is not null and "messages"."recipient_department_id" is null)
        or
        ("messages"."addressing_mode" = 'department' and "messages"."recipient_department_id" is not null and "messages"."recipient_agent_id" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "message_dead_letters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid,
	"reason" text NOT NULL,
	"detail" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"status" text NOT NULL,
	"redriven_at" timestamp with time zone,
	"redriven_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_dead_letters_status_check" CHECK (status in ('open', 'redriven'))
);
--> statement-breakpoint
CREATE TABLE "message_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"worker_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_outbox_message_attempt_unique" UNIQUE("message_id","attempt"),
	CONSTRAINT "message_outbox_status_check" CHECK (status in ('pending', 'publishing', 'published', 'failed')),
	CONSTRAINT "message_outbox_attempt_check" CHECK ("message_outbox"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "message_processing_records" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_processing_status_check" CHECK (status in ('processing', 'recorded', 'acknowledged', 'rejected', 'expired', 'dead_lettered', 'retry_scheduled'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_department_id_departments_id_fk" FOREIGN KEY ("sender_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_agent_id_agents_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_department_id_departments_id_fk" FOREIGN KEY ("recipient_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_inbox_department_id_departments_id_fk" FOREIGN KEY ("inbox_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_dead_letters" ADD CONSTRAINT "message_dead_letters_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_delivery_attempts" ADD CONSTRAINT "message_delivery_attempts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_processing_records" ADD CONSTRAINT "message_processing_records_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_idempotency_idx" ON "messages" USING btree ("sender_agent_id","idempotency_key") WHERE "messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_correlation_idx" ON "messages" USING btree ("correlation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_recipient_agent_idx" ON "messages" USING btree ("recipient_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_recipient_department_idx" ON "messages" USING btree ("recipient_department_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_created_at_id_idx" ON "messages" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_dead_letters_one_open_idx" ON "message_dead_letters" USING btree ("message_id") WHERE "message_dead_letters"."status" = 'open' and "message_dead_letters"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "message_dead_letters_created_idx" ON "message_dead_letters" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "message_delivery_attempts_message_idx" ON "message_delivery_attempts" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "message_outbox_claim_idx" ON "message_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "message_outbox_lease_idx" ON "message_outbox" USING btree ("lease_until");--> statement-breakpoint
CREATE INDEX "message_processing_status_idx" ON "message_processing_records" USING btree ("status");