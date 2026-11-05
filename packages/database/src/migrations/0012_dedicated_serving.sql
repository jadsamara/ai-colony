ALTER TABLE "routing_decisions" ADD COLUMN "serving_instance_id" uuid;
ALTER TABLE "routing_decisions" ADD COLUMN "endpoint_reference" text;
ALTER TABLE "routing_decisions" ADD COLUMN "agent_id" uuid;
ALTER TABLE "routing_decisions" ADD COLUMN "serving_policy_version" text;

CREATE TABLE "department_serving_instances" (
  "id" uuid PRIMARY KEY,
  "department_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "endpoint_reference" text NOT NULL,
  "normalized_endpoint" text NOT NULL,
  "model_registry_id" uuid NOT NULL,
  "model_version" text NOT NULL,
  "artifact_digest" text,
  "deployment_mode" text NOT NULL,
  "status" text NOT NULL,
  "resource_policy_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "department_serving_instances_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "department_serving_instances_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE restrict,
  CONSTRAINT "department_serving_instances_model_fk" FOREIGN KEY ("model_registry_id") REFERENCES "models"("id") ON DELETE restrict,
  CONSTRAINT "department_serving_instances_department_unique" UNIQUE ("department_id"),
  CONSTRAINT "department_serving_instances_endpoint_ref_unique" UNIQUE ("endpoint_reference"),
  CONSTRAINT "department_serving_instances_endpoint_unique" UNIQUE ("normalized_endpoint"),
  CONSTRAINT "department_serving_instances_provider_check" CHECK ("provider" in ('ollama', 'vllm', 'sglang')),
  CONSTRAINT "department_serving_instances_status_check" CHECK ("status" in ('configured', 'starting', 'ready', 'unavailable', 'stopped')),
  CONSTRAINT "department_serving_instances_mode_check" CHECK ("deployment_mode" = 'dedicated')
);

CREATE TABLE "department_serving_events" (
  "id" uuid PRIMARY KEY,
  "instance_id" uuid NOT NULL,
  "from_status" text NOT NULL,
  "to_status" text NOT NULL,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "department_serving_events_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "department_serving_instances"("id") ON DELETE restrict
);

CREATE TABLE "department_agent_checkpoints" (
  "id" uuid PRIMARY KEY,
  "agent_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "serving_instance_id" uuid NOT NULL,
  "model_version" text NOT NULL,
  "endpoint_reference" text NOT NULL,
  "state" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "department_agent_checkpoints_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE restrict,
  CONSTRAINT "department_agent_checkpoints_department_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE restrict,
  CONSTRAINT "department_agent_checkpoints_instance_fk" FOREIGN KEY ("serving_instance_id") REFERENCES "department_serving_instances"("id") ON DELETE restrict,
  CONSTRAINT "department_agent_checkpoints_task_unique" UNIQUE ("agent_id", "task_id")
);
