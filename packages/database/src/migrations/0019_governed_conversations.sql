ALTER TABLE "conversation_participants" ADD COLUMN "join_sequence" integer DEFAULT 0 NOT NULL;
ALTER TABLE "conversation_participants" ADD COLUMN "participant_role" text DEFAULT 'participant' NOT NULL;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_role_check" CHECK ("participant_role" in ('opener', 'participant', 'specialist', 'evaluator'));
ALTER TABLE "department_conversations" ADD COLUMN "recommended_speaker_id" uuid;
ALTER TABLE "department_conversations" ADD CONSTRAINT "department_conversations_recommended_speaker_fk" FOREIGN KEY ("recommended_speaker_id") REFERENCES "departments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "department_conversations" ADD COLUMN "speaker_recommendation_reason" text;
