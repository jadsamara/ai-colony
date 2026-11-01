-- Merge AI Colony M4 rows from the Docker database into the canonical
-- Homebrew database. This script only inserts. It does not update or delete
-- existing public rows. Invoke with psql -v ON_ERROR_STOP=1 -v dry_run=1
-- for a rollback, or -v dry_run=0 to commit.
--
-- The Docker server is read through postgres_fdw. The remote database is not
-- modified. One sender idempotency key, health:worker_stale:colony, already
-- identifies a different canonical message. That incoming message is inserted
-- with its original key preserved in metadata and a message-id suffix on the
-- unique key. Every other incoming primary key must be absent.

CREATE EXTENSION IF NOT EXISTS postgres_fdw;
DROP SCHEMA IF EXISTS m4_remote CASCADE;
DROP SERVER IF EXISTS m4_docker CASCADE;
CREATE SERVER m4_docker FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host '127.0.0.1', port '5434', dbname 'ai_colony');
CREATE USER MAPPING FOR colony SERVER m4_docker
  OPTIONS (user 'colony', password 'colony');
CREATE SCHEMA m4_remote;
IMPORT FOREIGN SCHEMA public
  LIMIT TO (
    permissions, role_permissions, checkpoint_migrations,
    objective_runs, objective_plans, objective_tasks, task_assignments, task_results,
    messages, message_outbox, message_processing_records, message_delivery_attempts,
    inference_requests, inference_usage, workflow_events, audit_events, worker_heartbeats,
    checkpoints, checkpoint_blobs, checkpoint_writes,
    memories, memory_embeddings, memory_sources, memory_revisions,
    memory_retrieval_events, memory_retrieval_hits, memory_promotion_requests,
    memory_consolidation_records, memory_contradictions, memory_embedding_usage
  )
  FROM SERVER m4_docker INTO m4_remote;

BEGIN;

DO $$
DECLARE
  conflicts text;
BEGIN
  SELECT string_agg(format('%s description %L vs %L', p.name, p.description, r.description), '; ')
    INTO conflicts
  FROM m4_remote.permissions r
  JOIN public.permissions p ON p.name = r.name
  WHERE p.description IS DISTINCT FROM r.description;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'permission description conflict: %', conflicts;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM m4_remote.checkpoint_migrations r
    JOIN public.checkpoint_migrations l USING (v)
    WHERE r IS DISTINCT FROM l
  ) THEN
    RAISE EXCEPTION 'checkpoint_migrations row differs for an existing version';
  END IF;
END $$;

-- Primary-key collisions on historical tables are unresolved. Stop.
DO $$
DECLARE
  tbl text;
  overlap bigint;
  tables text[] := ARRAY[
    'objective_runs','objective_plans','objective_tasks','task_assignments','task_results',
    'messages','message_outbox','message_delivery_attempts',
    'inference_requests','inference_usage','workflow_events','audit_events',
    'checkpoints','checkpoint_blobs','checkpoint_writes',
    'memories','memory_embeddings','memory_sources','memory_revisions',
    'memory_retrieval_events','memory_retrieval_hits','memory_promotion_requests',
    'memory_consolidation_records','memory_contradictions','memory_embedding_usage'
  ];
  keys text[] := ARRAY[
    'id','id','id','id','id',
    'id','id','id',
    'id','request_id','id','event_id',
    'thread_id, checkpoint_ns, checkpoint_id',
    'thread_id, checkpoint_ns, channel, version',
    'thread_id, checkpoint_ns, checkpoint_id, task_id, idx',
    'id','memory_id','id','id',
    'id','event_id, memory_id','id',
    'id','memory_id, other_memory_id','id'
  ];
BEGIN
  FOR i IN 1..array_length(tables, 1) LOOP
    tbl := tables[i];
    EXECUTE format(
      'SELECT count(*) FROM m4_remote.%I r JOIN public.%I l ON (%s) = (%s)',
      tbl, tbl,
      (SELECT string_agg('r.' || trim(part), ', ') FROM unnest(string_to_array(keys[i], ',')) AS part),
      (SELECT string_agg('l.' || trim(part), ', ') FROM unnest(string_to_array(keys[i], ',')) AS part)
    ) INTO overlap;
    IF overlap <> 0 THEN
      RAISE EXCEPTION 'primary key overlap in %: % rows', tbl, overlap;
    END IF;
  END LOOP;

  SELECT count(*) INTO overlap
  FROM m4_remote.message_processing_records r
  JOIN public.message_processing_records l ON l.message_id = r.message_id;
  IF overlap <> 0 THEN
    RAISE EXCEPTION 'primary key overlap in message_processing_records: % rows', overlap;
  END IF;

  SELECT count(*) INTO overlap
  FROM m4_remote.worker_heartbeats r
  JOIN public.worker_heartbeats l ON l.worker_id = r.worker_id;
  IF overlap <> 0 THEN
    RAISE EXCEPTION 'primary key overlap in worker_heartbeats: % rows', overlap;
  END IF;
END $$;

CREATE TEMP TABLE consolidation_before AS
SELECT 'objective_runs' AS tbl, count(*)::bigint AS rows FROM objective_runs
UNION ALL SELECT 'departments', count(*) FROM departments
UNION ALL SELECT 'audit_events', count(*) FROM audit_events
UNION ALL SELECT 'messages', count(*) FROM messages
UNION ALL SELECT 'memories', count(*) FROM memories;

INSERT INTO public.permissions (name, description)
SELECT r.name, r.description
FROM m4_remote.permissions r
WHERE NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.name = r.name);

INSERT INTO public.role_permissions (role_name, permission_name)
SELECT r.role_name, r.permission_name
FROM m4_remote.role_permissions r
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions p
  WHERE p.role_name = r.role_name AND p.permission_name = r.permission_name
);

INSERT INTO public.objective_runs
SELECT * FROM m4_remote.objective_runs;
INSERT INTO public.objective_plans
SELECT * FROM m4_remote.objective_plans;
INSERT INTO public.objective_tasks
SELECT * FROM m4_remote.objective_tasks;
INSERT INTO public.task_assignments
SELECT * FROM m4_remote.task_assignments;
INSERT INTO public.task_results
SELECT * FROM m4_remote.task_results;

INSERT INTO public.messages (
  id, protocol_version, message_type, sender_agent_id, sender_department_id,
  recipient_agent_id, recipient_department_id, addressing_mode, inbox_department_id,
  correlation_id, causation_id, reply_to_message_id, priority, payload,
  payload_schema_version, payload_hash, idempotency_key, metadata, status,
  expires_at, created_at, updated_at
)
SELECT
  s.id, s.protocol_version, s.message_type, s.sender_agent_id, s.sender_department_id,
  s.recipient_agent_id, s.recipient_department_id, s.addressing_mode, s.inbox_department_id,
  s.correlation_id, s.causation_id, s.reply_to_message_id, s.priority, s.payload,
  s.payload_schema_version, s.payload_hash,
  CASE
    WHEN c.id IS NOT NULL THEN s.idempotency_key || ':' || s.id::text
    ELSE s.idempotency_key
  END,
  CASE
    WHEN c.id IS NOT NULL THEN COALESCE(s.metadata, '{}'::jsonb) || jsonb_build_object(
      'originalIdempotencyKey', s.idempotency_key,
      'canonicalMessageId', c.id,
      'consolidation', 'sender idempotency key already identified a different canonical message'
    )
    ELSE s.metadata
  END,
  s.status, s.expires_at, s.created_at, s.updated_at
FROM m4_remote.messages s
LEFT JOIN public.messages c
  ON c.sender_agent_id = s.sender_agent_id
 AND c.idempotency_key = s.idempotency_key
 AND c.idempotency_key IS NOT NULL
 AND c.id <> s.id;

INSERT INTO public.message_outbox SELECT * FROM m4_remote.message_outbox;
INSERT INTO public.message_processing_records SELECT * FROM m4_remote.message_processing_records;
INSERT INTO public.message_delivery_attempts SELECT * FROM m4_remote.message_delivery_attempts;
INSERT INTO public.inference_requests SELECT * FROM m4_remote.inference_requests;
INSERT INTO public.inference_usage SELECT * FROM m4_remote.inference_usage;
INSERT INTO public.workflow_events SELECT * FROM m4_remote.workflow_events;
INSERT INTO public.audit_events SELECT * FROM m4_remote.audit_events;
INSERT INTO public.worker_heartbeats SELECT * FROM m4_remote.worker_heartbeats;
INSERT INTO public.checkpoint_migrations
SELECT * FROM m4_remote.checkpoint_migrations r
WHERE NOT EXISTS (SELECT 1 FROM public.checkpoint_migrations l WHERE l.v = r.v);
INSERT INTO public.checkpoints SELECT * FROM m4_remote.checkpoints;
INSERT INTO public.checkpoint_blobs SELECT * FROM m4_remote.checkpoint_blobs;
INSERT INTO public.checkpoint_writes SELECT * FROM m4_remote.checkpoint_writes;
INSERT INTO public.memories SELECT * FROM m4_remote.memories;
INSERT INTO public.memory_embeddings SELECT * FROM m4_remote.memory_embeddings;
INSERT INTO public.memory_sources SELECT * FROM m4_remote.memory_sources;
INSERT INTO public.memory_revisions SELECT * FROM m4_remote.memory_revisions;
INSERT INTO public.memory_retrieval_events SELECT * FROM m4_remote.memory_retrieval_events;
INSERT INTO public.memory_retrieval_hits SELECT * FROM m4_remote.memory_retrieval_hits;
INSERT INTO public.memory_promotion_requests SELECT * FROM m4_remote.memory_promotion_requests;
INSERT INTO public.memory_consolidation_records SELECT * FROM m4_remote.memory_consolidation_records;
INSERT INTO public.memory_contradictions SELECT * FROM m4_remote.memory_contradictions;
INSERT INTO public.memory_embedding_usage SELECT * FROM m4_remote.memory_embedding_usage;

DO $$
DECLARE
  bad bigint;
  before_objectives bigint;
  before_departments bigint;
  before_messages bigint;
BEGIN
  SELECT rows INTO before_objectives FROM consolidation_before WHERE tbl = 'objective_runs';
  SELECT rows INTO before_departments FROM consolidation_before WHERE tbl = 'departments';
  SELECT rows INTO before_messages FROM consolidation_before WHERE tbl = 'messages';

  IF (SELECT count(*) FROM objective_runs) <> before_objectives + (SELECT count(*) FROM m4_remote.objective_runs) THEN
    RAISE EXCEPTION 'objective count mismatch';
  END IF;
  IF (SELECT count(*) FROM departments) <> before_departments THEN
    RAISE EXCEPTION 'department count changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM departments WHERE slug = 'engineering') THEN
    RAISE EXCEPTION 'engineering department is missing';
  END IF;
  IF (SELECT count(*) FROM messages) <> before_messages + (SELECT count(*) FROM m4_remote.messages) THEN
    RAISE EXCEPTION 'message count mismatch';
  END IF;
  IF (SELECT count(*) FROM memories) <> (SELECT count(*) FROM m4_remote.memories) THEN
    RAISE EXCEPTION 'memory count mismatch';
  END IF;
  IF (SELECT count(*) FROM memory_embeddings) <> (SELECT count(*) FROM m4_remote.memory_embeddings) THEN
    RAISE EXCEPTION 'embedding count mismatch';
  END IF;
  SELECT count(*) INTO bad FROM memory_embeddings WHERE vector_dims(embedding) <> 768;
  IF bad <> 0 THEN
    RAISE EXCEPTION '% embeddings are not 768-dimensional', bad;
  END IF;
  SELECT count(*) INTO bad
  FROM memory_embeddings l
  JOIN m4_remote.memory_embeddings r USING (memory_id)
  WHERE l.embedding::text IS DISTINCT FROM r.embedding::text
     OR l.model_name IS DISTINCT FROM r.model_name
     OR l.dimensions IS DISTINCT FROM r.dimensions;
  IF bad <> 0 THEN
    RAISE EXCEPTION '% embeddings differ from the source', bad;
  END IF;
  IF (SELECT count(*) FROM objective_runs o JOIN m4_remote.objective_runs r USING (id))
     <> (SELECT count(*) FROM m4_remote.objective_runs) THEN
    RAISE EXCEPTION 'an M4 objective is missing';
  END IF;
  IF (SELECT count(*) FROM objective_runs) - (SELECT count(*) FROM m4_remote.objective_runs) <> before_objectives THEN
    RAISE EXCEPTION 'an original objective was replaced';
  END IF;
  SELECT count(*) INTO bad
  FROM messages
  WHERE metadata ? 'originalIdempotencyKey';
  IF bad <> 1 THEN
    RAISE EXCEPTION 'expected exactly one disambiguated message, found %', bad;
  END IF;
END $$;
