CREATE TABLE "product_improvement_proposals" (
  "id" uuid PRIMARY KEY,
  "department_id" uuid NOT NULL,
  "proposed_by_agent_id" uuid NOT NULL,
  "problem" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "expected_benefit" text NOT NULL,
  "participants" jsonb NOT NULL,
  "estimated_cost" text NOT NULL,
  "risk" text NOT NULL,
  "success_criteria" text NOT NULL,
  "priority" text NOT NULL,
  "dependencies" jsonb NOT NULL,
  "approval_requirements" jsonb NOT NULL,
  "recommends_new_department" boolean NOT NULL,
  "status" text NOT NULL,
  "evaluation_evidence" jsonb,
  "recommendation" text,
  "outcome" text,
  "successful" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "product_improvement_proposals_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "product_improvement_proposals_agent_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "agents"("id") ON DELETE restrict,
  CONSTRAINT "product_improvement_proposals_status_check" CHECK ("status" in ('proposed', 'under_review', 'approved', 'in_progress', 'evaluating', 'completed', 'rejected')),
  CONSTRAINT "product_improvement_proposals_priority_check" CHECK ("priority" in ('low', 'medium', 'high')),
  CONSTRAINT "product_improvement_proposals_recommendation_check" CHECK ("recommendation" is null or "recommendation" in ('retain', 'revise', 'revert'))
);

CREATE INDEX "product_improvement_proposals_status_idx" ON "product_improvement_proposals" ("status");
CREATE INDEX "product_improvement_proposals_department_idx" ON "product_improvement_proposals" ("department_id");

CREATE TABLE "product_improvement_events" (
  "id" uuid PRIMARY KEY,
  "proposal_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "product_improvement_events_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "product_improvement_proposals"("id") ON DELETE restrict
);

CREATE INDEX "product_improvement_events_proposal_idx" ON "product_improvement_events" ("proposal_id", "created_at");
