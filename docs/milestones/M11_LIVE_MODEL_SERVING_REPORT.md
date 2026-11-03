# M11 — Live department model serving

Status: **Live shared-model inference verified; live specialized-model serving pending.**

**Legacy PostgreSQL 5434 audited — deletion awaiting operator approval.**

These states are separate:

| State | Result |
| --- | --- |
| Code implemented | Yes. Live catalog evidence, a loaded-model limit, and execution audit fields are on `m11-live-model-serving`. |
| Tests passed | Yes. Unit 195 passed. Integration 51 passed. |
| Governed Qwen3-8B execution | Yes, on disposable PostgreSQL port `5435`. The backend returned `four`. |
| Canonical live execution | Not demonstrated. The smoke test did not write to `ai_colony`. |
| Canonical schema change | None in M11. Migration `0011` remains the latest applied migration. |
| Runtime workers started | No. |
| Specialized or adapter live execution | No. |
| Port 5434 removed | No. |

## 1. Executive summary

The department router now records a read-only Ollama catalog before a new routing decision. The catalog supplies the installed digest, artifact size, and loaded-model list. A second large loaded model, or a loaded model with no reported size, denies the new decision with `resource_denied`. It does not select another model. A chat response that includes a different digest fails the inference request. A successful response does not mark the digest verified.

One reasoning-department task ran through `claimSpecialist` and `executePrepared` against local Ollama. The pinned alias was `qwen3:8b`. The stored digest matches the `/api/tags` digest. `execution_verification` stayed `unverified`. No second approved model is installed, and no adapter artifact was created.

## 2. Git branch and commit

- Branch: `m11-live-model-serving`
- Implementation commit: `68c718b63c5dcd625215bfa318db3f8b51f5a543`
- Base: `d3c1d6aa0f4baa36023514b5c4fe4a3e4ade38db` on `m10.1-routing-activation`
- M10 implementation: `04afc2996e52f451c287423fe1aff9e9874a79fd`
- M10.1 activation report: `b6542189b14d0f272769116d162a75ff97cf7866`

Untracked files left out of the commit: `docs/audits/` and `docs/milestones/M9_1_CANONICAL_ACTIVATION_REPORT.md`.

## 3. Ollama runtime state

Read-only probes were `GET /api/version`, `GET /api/tags`, and `GET /api/ps`. No pull, create, or restart was issued.

| Check | Before the smoke test | After the smoke test |
| --- | --- | --- |
| Reachable | yes | yes |
| Version | `0.40.13` | same process |
| `qwen3:8b` installed | yes | yes |
| Installed digest | `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41` | same |
| Artifact size | 5,225,388,164 bytes | same |
| Loaded before the call | no | `qwen3:8b` loaded, resident size 5,076,072,529 bytes, same digest |
| Other installed model | `embeddinggemma:latest`, 621,875,917 bytes | not loaded |

Installed, loaded, and inference-ready were different states. The model was installed and unloaded when the decision was pinned. Ollama loaded it during the governed request.

## 4. Live Qwen3-8B inference result

Category: governed end-to-end inference. Direct `ollama generate` was not used.

| Field | Value |
| --- | --- |
| Database | `127.0.0.1:5435` / `colony_m11_live` |
| Department | Reasoning `00000000-0000-4000-8000-00000000001a` |
| Objective | `418503c3-f091-4e3a-bebb-31a7da530865` |
| Task | `625320a7-6eb2-404a-a42d-335d496ce9cc` |
| Routing decision | `7d9ec42b-590e-4bef-81e9-d38fb77b2be9` |
| Authorization | `authorized_legacy_default` |
| Registry model | Qwen3-8B `00000000-0000-4000-8000-000000000101` |
| Serving alias sent and returned | `qwen3:8b` |
| Digest recorded at decision time | `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41` |
| Execution verification | `unverified` |
| Fallback | `disabled` |
| Output | `four` |
| Tokens | 99 input, 2 output |
| Latency | 4,654 ms inside the audit row; 4,669 ms around the call |
| Outcome | completed |

The prompt asked for the single word four. `maxOutputTokens` was 32 and the timeout was 180 seconds. The call finished in under 5 seconds. No RabbitMQ message was published and no production worker was started.

## 5. Governed routing execution evidence

`executePrepared` remains the production `provider.generate` call. The smoke test used that function after `claimSpecialist`. The audit event `routing.execution` records the decision id, task, department model id, serving alias, digest, assignment version, adapter id, resource outcome, verification status, token counts, and latency. The prompt text was not stored.

Workers refresh the Ollama catalog before a CEO pass and before a specialist or orchestration message. A pinned decision is not recomputed. An assignment change after the pin still cannot change the task model.

## 6. Model digest verification limitations

The digest on the decision is the digest from `/api/tags` for the selected tag. The OpenAI-compatible chat response did not include a digest, so the completion was not compared with that value. `execution_verification` therefore stays `unverified`. If a response does include `digest` and it differs from the pinned digest, the request is failed and is not completed. A successful text response is not treated as proof of the digest.

## 7. Specialized-model serving status

**Live shared-model inference verified; live specialized-model serving pending.**

Ollama has `qwen3:8b` and `embeddinggemma:latest`. Qwen3-4B and Gemma 3 270M remain `not_deployed` and are not installed. No model was downloaded. No production assignment was created. Scripted tests still show a deployment-authorized specialized alias and a denial when the registry status is not `available`.

## 8. Adapter-derived serving status

No approved adapter or derived Ollama artifact was present. None was created or promoted. A `capability_adapter` assignment still requires `provenanceVerified`, the base registry id, and the adapter id. A matching tag alone is not provenance. The scripted derived-model test still sends `research-adapter:v3` only when that evidence is supplied.

## 9. Task-level model consistency

Existing isolated tests still cover one decision per task, reuse after an assignment change, resumed leases, and a served-model mismatch. The new digest check fails closed without a fallback. Routing denials and execution failures remain separate audit actions. The live task received one decision and one completion for `qwen3:8b`.

## 10. Memory and resource measurements

Machine total from the OS: 25,769,803,776 bytes (24 GiB).

| Sample | Free bytes reported by the OS | Ollama processes |
| --- | --- | --- |
| Before | 691,503,104 | `ollama` RSS 28,080 KB |
| After | 110,821,376 | `llama-server` RSS 701,408 KB and `ollama` RSS 32,144 KB |

Ollama reported the loaded model at 5,076,072,529 bytes. That figure is larger than the RSS of `llama-server`, and the free-memory drop is smaller than the artifact. Those counters are not a measured peak of unified-memory pressure. No second large model was started. Nothing was unloaded by this process.

## 11. Concurrency controls

Existing limits remain: provider `maxConcurrency` default 1, objective global concurrency default 1, and department concurrency default 1. The new application check refuses a new decision when another loaded model is at least 2 GiB or has no reported size. A model smaller than 2 GiB, such as the embedding model, does not trip that limit. An artifact larger than 16 GiB is refused on size. Neither check unloads a model or measures the operating-system memory limit. `memory_unknown` is still the recorded outcome when the requested model is not already loaded with a size.

## 12. Evaluation isolation

Evaluation code does not call `evaluateRouting` or write ledger snapshots. Operational routing does not insert capability snapshots. A model-generated contribution is still refused by `promotionAllowed`. Paired evaluation keeps `deploymentAuthorization` as `separate_decision_required`. No real-model evaluation suite was run.

## 13. Unit and integration test results

| Suite | Passed | Skipped | Failed |
| --- | --- | --- | --- |
| Unit, including ledger, routing, resource, and evaluation tests | 195 | 0 | 0 |
| Integration, including isolated RabbitMQ on port 5673 | 51 | 0 | 0 |

Typecheck passed. ESLint passed on the M11 source files. `tests/smoke/real-model.test.ts` was not run. The governed smoke test above is a separate one-task run.

## 14. Canonical migration status

No M11 migration was added. A read-only check after the smoke test showed canonical `127.0.0.1:5433` / `ai_colony`, data directory `/tmp/ai-colony-pg`, 12 migration rows, latest timestamp `1793553000000`, 13 departments, and 0 routing decisions. Historical evaluation and ledger rows were not modified.

## 15. PostgreSQL 5434 audit

| Item | Value |
| --- | --- |
| Container | `ai-colony-postgres` `66f54fc263a0` |
| Image | `pgvector/pgvector:pg16` |
| Server | PostgreSQL 16.15 |
| Compose project | `ai-colony`, service `postgres`, file `docker-compose.yml` |
| Published port | `0.0.0.0:5434` to container port 5432 |
| Restart | `unless-stopped` |
| Data volume | `ai-colony_ai_colony_postgres` at `/var/lib/docker/volumes/ai-colony_ai_colony_postgres/_data` |
| Bind mount | `docker/postgres/init.sql`, read-only |
| Databases | `ai_colony` (13,032,471 bytes), `ai_colony_test` (10,877,975 bytes), `postgres` |
| Active sessions during the audit | 0 |
| Repository runtime URL | canonical code and `.env.example` use port 5433. Integration tests use port 5435. Old research scripts mention 5434 and were not running. |

`ai_colony` on port 5434 is an older copy. Its 12 memories, 645 checkpoints, 54 audit events, 15 messages, and 2 objective runs are all present in canonical PostgreSQL, which has additional rows. It has 4 migrations, ending at `1793511336200`. It has no `routing_decisions` table and no engineering department.

`ai_colony_test` has 68 `checkpoint_blobs` rows for thread `ceo:41bdec68-3def-43ac-bebc-b845b3c49611` that are not in canonical PostgreSQL. Its one principal is already in canonical. Those blobs were not copied.

## 16. Legacy database retirement status

Backups, both custom format, `pg_restore --list` succeeded with 262 entries each:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `/Users/jad/Desktop/ai-colony-backups/ai_colony-5434-pre-retire-20261103T040715Z.dump` | 283,996 | `dc665889b73d099c2931add1447a5a4f69fa4c82e5ef397c2222c6d94e65ef4a` |
| `/Users/jad/Desktop/ai-colony-backups/ai_colony_test-5434-pre-retire-20261103T040715Z.dump` | 116,214 | `f62da60921516fc50d42d48a94a232ff9137d68d8c6ea46e8b68f008630e0a71` |

The container and volume were left in place because of the unique checkpoint blobs. Compose was not edited. Port 5433 and port 5435 were not restarted. Recovery is `pg_restore` of those archives into a new empty database, not over `ai_colony` on port 5433.

Deletion should wait until the operator accepts dropping those 68 blobs. The approval gate, when that decision is made, is:

**APPROVE M11 LEGACY POSTGRESQL 5434 DELETION — VERIFIED CONTAINER AND DEDICATED VOLUMES ONLY**

## 17. Remaining infrastructure risks

- Canonical data still lives in `/tmp/ai-colony-pg`.
- Execution digests are not attested by the chat response.
- The loaded-model limit does not control Ollama's own loader and does not measure unified-memory pressure.
- Free memory was already low before the smoke test. A second large model was not attempted.
- Port 5434 is published on all interfaces and restarts unless stopped.
- Canonical workers still do not have a demonstrated live task in `ai_colony`.

## 18. Readiness for M12

Do not start M12 from this milestone. Shared Qwen3-8B can execute through the governed path on an isolated database. Specialized serving, adapter serving, canonical worker execution, and removal of port 5434 are still open. M12 would need its own scope. Training and automatic adapter promotion were not implemented.
