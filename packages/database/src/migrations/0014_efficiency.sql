ALTER TABLE "objective_runs" ADD COLUMN "execution_path" text;
ALTER TABLE "objective_runs" ADD COLUMN "execution_rationale" text;
ALTER TABLE "objective_runs" ADD COLUMN "planning_completed_at" timestamptz;
ALTER TABLE "objective_runs" ADD COLUMN "synthesis_started_at" timestamptz;
ALTER TABLE "objective_runs" ADD CONSTRAINT "objective_runs_execution_path_check" CHECK ("execution_path" is null or "execution_path" in ('direct', 'lightweight', 'full'));
