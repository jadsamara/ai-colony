# M9 — Department Capability Ledger

## 1. Executive summary

M9 adds a Department Capability Ledger. Departments can propose a topic taxonomy and benchmark mappings. Evaluation evidence, checked through the M8.2 contract, is the only source of an official score. Governance activates taxonomy structure. The ledger stores those decisions and measurements as append-only history.

The ledger is not a knowledge base, a model checkpoint, or a learning engine. It does not train, call Ollama, promote an adapter, or change department model routing. Migration `0009_department_capability_ledger` was applied only to a disposable PostgreSQL database on port 5435. It was not applied to canonical PostgreSQL. M9 is implemented and tested in isolation. It is not deployed or operational on the canonical database.

## 2. Architecture and component ownership

The principle is: departments propose, evaluation measures, the ledger remembers, and governance decides.

- A department may register topic identities, propose a hierarchy, propose benchmark mappings, and read its own authorized reports. It cannot activate its own taxonomy or certify its own score.
- Evaluation certification uses the existing `evaluation:suite:approve` permission. Scores come from supplied item outcomes and deterministic Wilson intervals. An LLM does not invent a score, and neural weights are not inspected.
- Governance activation of a taxonomy uses the existing `capability:approve` permission. The proposer cannot approve the same proposal.
- Memory & Forgetting can append a retention event. That event changes visibility. It does not delete the row.
- Weight Optimization can read approved evidence for any department. It cannot rewrite or certify a finding.
- A cross-link records a related topic. The reconstructed link always carries `grantsMemoryAccess: false`. The ledger never reads department memory.

The existing `department_capabilities` tables remain the learning-cycle records. The ledger uses new `ledger_*` tables so a learning proposal is not treated as a measurement.

## 3. Database schema and migration details

Migration `packages/database/src/migrations/0009_department_capability_ledger.sql` creates:

| Table | Role |
| --- | --- |
| `ledger_topics` | Stable topic identity and owning department |
| `ledger_topic_events` | Rename, description, and deprecation events |
| `ledger_proposals` | Taxonomy or mapping proposals |
| `ledger_decisions` | One approval or rejection per proposal |
| `ledger_taxonomy_versions` | Immutable version header per department |
| `ledger_taxonomy_edges` | Parent and cross-link edges for one version |
| `ledger_mapping_versions` | Approved mapping header pinned to one taxonomy version |
| `ledger_topic_mappings` | Item id, content digest, topic, and optional weight |
| `ledger_snapshots` | One capability measurement |
| `ledger_retention_events` | Retain, revoke, or archive visibility |

Foreign keys use `ON DELETE RESTRICT`. A topic cannot parent itself. A mapping digest must be 64 hex characters. A snapshot's correct and incorrect counts must sum to its sample size, and the sample size must be positive. `evaluation_run_id` is a nullable foreign key so a historical file can be cited through `evidence_ref` without inserting a colony run.

`migrateDatabase` installs `BEFORE UPDATE` and `BEFORE DELETE` triggers on every ledger table. The triggers call the existing `colony_reject_training_mutation` function. Application repositories expose insert and read methods only.

## 4. Taxonomy versioning design

Topic identity and taxonomy structure are separate. `registerTopic` creates an id. Later renames are events. A name stored on an edge belongs to that version.

`proposeTaxonomy` validates the graph before anything is activated. Activation copies the proposed nodes into `ledger_taxonomy_edges`. A later version can move or deprecate a topic. `reconstructTaxonomy` reads only that version's edges, so yesterday's parent remains yesterday's parent.

The graph allows nested parents and cross-links. Cycle detection walks parent links and uses `assertNoHierarchyCycle`. Cross-links are not parent links, so a mutual reference does not become a parent cycle. Every parent node must belong to the proposing department. A cross-link may name an existing topic in another department.

The database rejects a self-parent. Longer cycles are rejected by the service before insert. A direct SQL writer could still insert a longer cycle; the authorized service path cannot.

## 5. Benchmark mapping governance

A department submits item id, content digest, topic, provenance, and an optional weight. Weight is not treated as equal evidence and is not used in the accuracy formula. Accuracy is correct outcomes divided by sample size for the items included in that snapshot.

Evaluation must approve the mapping with `evaluation:suite:approve`. The approver cannot be the proposer, and the approver's department cannot be the department being scored. Approval inserts a new mapping version. Older mapping rows are left in place. A snapshot stores the mapping version id it used.

The service rejects a missing topic, a topic outside the taxonomy version, a topic owned by another department, and a snapshot item whose id or digest is not on that approved mapping.

## 6. Immutable snapshot design

`certifySnapshot` parses the manifest with `parseEvaluationManifest`. It requires a completed run, a retrieval mode that matches `closed_book` or `retrieval_assisted`, a known item count, and one valid outcome per included item. An empty measurement is rejected, so a missing topic stays untested rather than becoming accuracy zero.

The snapshot stores schema version `m9-capability-snapshot-v1`, the configuration fingerprint, model family, model identifier, checkpoint digest, and adapter identity when the manifest actually sets them. Unknown manifest fields stay null. Assigned-model and serving-model fields are not stored. Read models return them as separate nulls beside the historical identity.

On the disposable database, `UPDATE` and `DELETE` against `ledger_topics` and `ledger_snapshots` raised the immutability exception. A second decision for one proposal conflicted. A self-parent edge was rejected. A topic pointing at a missing department was rejected.

## 7. Evaluation integration

Ledger comparison calls `parseEvaluationManifest`, `compareManifests` inside `analyzePairedRuns`, and `analyzePairedRuns`. It does not reimplement manifest matching or the exact McNemar test. `analyzePairedRuns` still returns its Wald interval, and the M8.2 tests still expect that interval.

Before a verdict, the ledger checks both snapshots are valid, both refer to the same topic, measurement mode and capability kind match, and the stored items agree with the approved mapping. If the mapping version changed, the comparison is `noncomparable` unless the caller sets `commonItemDesign`. Different item sets are `noncomparable` without that design. A token-budget mismatch remains `noncomparable` through the M8.2 contract, with no accuracy difference attached.

`capabilityKind` is either `model` or `agent_system`. Those snapshots are not compared with each other.

## 8. Statistical comparison methods

The ledger keeps the exact McNemar p-value from `analyzePairedRuns`. For the interval it uses `pairedScoreInterval`: a Wilson score interval on the share of improvements among discordant pairs, transformed back to `(2k - d) / n` and scaled by `d / n`. When every pair flips, the Wald interval collapses to `{1, 1}`. The Wilson interval keeps the same direction but its lower bound is below 1. Concordant pairs produce `{0, 0}` and an inconclusive verdict.

A raw accuracy change is not enough. Improvement requires the McNemar p-value to be below alpha and the Wilson interval to lie entirely above zero. Regression requires the interval to lie entirely below zero. Otherwise the verdict is inconclusive.

For more than one topic, `applyHolm` applies Holm's step-down procedure. Noncomparable topics have a null p-value and stay out of the family. Responses keep both `rawPValue` and `adjustedPValue`. An unadjusted p-value is not described as family-wise control.

`catastrophicForgetting` is always false. A regression verdict means a matched, previously measured capability declined. The default cause is `not_attributed`. An explicit adapter contrast can be labeled `contrast_named_adapter_change`. That label still does not certify that the adapter caused the change. `deploymentAuthorization` remains `separate_decision_required`.

## 9. Authorization boundaries

Server-side checks use the existing authorizer. The caller-supplied department id is compared with the actor.

- Propose a topic, taxonomy, or mapping: `learning:propose`, and the actor's department must own the proposal. A system administrator may propose for a department.
- Activate a taxonomy: `capability:approve`, and the deciding principal must differ from the proposer. The CEO role does not have this permission.
- Approve a mapping or certify a snapshot: `evaluation:suite:approve`. A department agent does not have this permission. Certification also fails when the actor's department is the department being scored.
- Read approved taxonomy, history, and snapshots: the owning department, a system administrator, a monitoring agent, a read-only observer, or the Weight Optimization, Evaluation, Monitoring, or Memory & Forgetting department.
- Another department's proposals are not readable.
- Record retention: Memory & Forgetting with `memory:forget:request`, or a system administrator with `memory:forget:approve`.

The seeded Evaluation agent uses `department_agent` and therefore cannot certify a score. That is fail-closed. The current role matrix grants `evaluation:suite:approve` and `capability:approve` only through `system_administrator`. No new permission or authorization framework was added.

A revoked snapshot disappears from ordinary department history. An administrator, Evaluation, or Memory & Forgetting can still read the row. The row remains in the table.

## 10. Historical reconstruction

`getTaxonomy` returns one version's tree. `history` returns measurements for a department or topic, ordered by measurement time. `overview` reports the newest valid snapshot per topic, untested active topics, freshness against a 30-day window, and Holm-adjusted comparisons of the two newest snapshots when both exist.

The newest snapshot is not selected by accuracy. A later weaker score remains the latest score. Freshness is `current` or `stale` and is separate from coverage. Untested topics have no snapshot and no accuracy. Stale evidence is still evidence. A historical snapshot does not claim the model is loaded or assigned. `assignedModel` and `servingModel` are always null in these responses.

## 11. Tests and results

Unit tests in `tests/unit/capability-ledger.test.ts` cover stable topic ids, version creation, parent links, cross-links, cycles, rename, deprecation, historical reconstruction, mapping validation, mapping-version isolation, cross-department refusal, append-only snapshots, untested versus weak coverage, invalid manifests, noncomparable configurations, matched comparisons, inconclusive pairs, Holm adjustment, timeline freshness, and governance.

`pnpm exec vitest run --config vitest.unit.config.ts` completed with 127 passed and 1 skipped. The skipped test is the database test, which runs only when `LEDGER_TEST_DATABASE_URL` is set. `tests/unit/evaluation-contract.test.ts` still passed, including the Wald interval of `{1, 1}` for a complete flip. `tsc -p tsconfig.typecheck.json --noEmit` passed. ESLint passed on the M9 source and tests.

The database test ran against `postgres://m9:m9test@127.0.0.1:5435/colony_ledger_m9` in a new container named `ai-colony-m9-ledger`, using the local `pgvector/pgvector:pg16` image. `assertDisposableDatabaseUrl` rejected ports 5433 and 5434 and the database name `ai_colony` before the connection. The test passed: migration, foreign key rejection, unique decision, self-parent rejection, and update/delete rejection. The container was removed afterward. The existing `ai-colony-postgres` container remained on port 5434 and was not modified.

The existing integration suite was not run. Its global setup can start the compose database and use the `ai_colony` name.

## 12. Known limitations

- Multi-level cycle prevention is enforced by the service. The database constraint covers a topic parenting itself.
- The seeded Evaluation department cannot certify until a principal with `evaluation:suite:approve` acts. The role matrix was not widened.
- Mapping weight is recorded and ignored by the score. It does not allocate partial credit across topics.
- Revocation hides a snapshot from ordinary reads. It does not erase backups or model weights.
- The ledger does not join live model assignment or the Ollama process. Those remain separate systems.
- Historical colony evaluation rows were not copied into snapshots.
- HTTP routes were typechecked and delegate to the service. The API process was not started.
- A direct database session that bypasses `migrateDatabase` would not receive the triggers, because the triggers are installed by `migrateDatabase` after the SQL migration, matching the existing audit-trigger pattern.

## 13. Migrations written but not applied

`0009_department_capability_ledger` is in the Drizzle journal. It was applied to the disposable `colony_ledger_m9` database on port 5435. It was not applied to canonical PostgreSQL. After the isolated test, `public.ledger_topics` was absent on the canonical database.

## 14. Canonical database safety confirmation

A read-only inspection through `createReadOnlyInspection` confirmed `transaction_read_only = on`, `data_directory = /tmp/ai-colony-pg`, and `port = 5433`. `evaluation_runs` still contained 5 rows. `to_regclass('public.ledger_topics')` was null. No insert, update, delete, migration, or backfill was issued against that database. Port 5434 was not contacted.

## 15. M10 readiness assessment

M10 can consume capability evidence through the public interfaces below. It should not reimplement manifest comparison, McNemar, or the ledger interval.

M10 is not ready to treat the ledger as operational data. The migration is not on the canonical database, the canonical data directory is still `/tmp/ai-colony-pg`, and historical evaluations have not been certified into snapshots. Adapter routing, adapter promotion, and continual training were not implemented.

## Public interfaces for M10

Service: `CapabilityLedgerService`.

- `registerTopic`, `recordTopicEvent`
- `proposeTaxonomy`, `decideTaxonomy`
- `proposeMapping`, `decideMapping`
- `certifySnapshot`
- `recordRetention`
- `listTaxonomyVersions`, `getTaxonomy`
- `getSnapshot`, `history`, `compare`, `overview`

Pure helpers, re-exported from `@ai-colony/core`:

- `validateTaxonomyGraph`, `reconstructTaxonomy`
- `compareCertifiedSnapshots`
- `pairedScoreInterval`
- `holmAdjust`, `applyHolm`
- `SNAPSHOT_SCHEMA_VERSION` (`m9-capability-snapshot-v1`)

Comparison still belongs to M8.2:

- `parseEvaluationManifest`
- `compareManifests`
- `analyzePairedRuns`

HTTP routes, all authorized inside the service:

- `POST /api/v1/capabilities/topics`
- `POST /api/v1/capabilities/topics/:id/events`
- `POST /api/v1/capabilities/taxonomy/proposals`
- `POST /api/v1/capabilities/taxonomy/proposals/:id/decision`
- `GET /api/v1/capabilities/taxonomy/versions`
- `GET /api/v1/capabilities/taxonomy/versions/:id`
- `POST /api/v1/capabilities/mappings/proposals`
- `POST /api/v1/capabilities/mappings/proposals/:id/decision`
- `POST /api/v1/capabilities/snapshots`
- `GET /api/v1/capabilities/snapshots/:id`
- `GET /api/v1/capabilities/history`
- `POST /api/v1/capabilities/comparisons`
- `POST /api/v1/capabilities/retention`
- `GET /api/v1/capabilities/departments/:id/overview`

Ledger verdicts use the M8.2 vocabulary: `improvement`, `regression`, `inconclusive`, `noncomparable`, `insufficient_evidence`, and `invalid_evaluation`. Those correspond to improvement evidence, regression evidence, inconclusive, noncomparable, insufficient evidence, and invalid evaluation.
