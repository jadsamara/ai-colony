# M8.2 Evaluation Contract Report

## 1. Executive summary

Two evaluation results can now be checked for a fair comparison before any improvement or regression claim. The contract records the model artifact, the benchmark item set, the prompt and scorer, and the generation settings. A pure comparison function returns comparable only when those controls match. Model and adapter identity may differ. Missing historical metadata stays unknown. A noncomparable pair does not receive an improvement or regression verdict.

The colony gate still uses the existing arithmetic scorer, Wilson interval, and exact McNemar test. New runs store the manifest in the existing `decoding` JSON and report summary. Historical rows are not rewritten. No migration was required. No canonical database write, live inference, or training was performed.

This does not show continual learning, a successful weight update, or catastrophic forgetting. The historical Gemma 8-token runs and the Qwen 32-token and 128-token files remain different experiments.

## 2. Existing evaluation architecture

Colony evaluation is one path. `EvaluationService.addVersion` freezes a benchmark with `contentHash`, `promptTemplateHash`, scorer `arithmetic` / `m6-equation-v1`, and decoding `{ strategy: "greedy", maxTokens: 8, temperature: 0 }`. `EvaluationService.run` grades supplied or provider outputs with `gradeArithmetic`, stores baseline and candidate rows, and summarizes them with `pairedCounts`, `wilsonInterval`, and `mcnemarExact`. `decide` applies `decideGate`. Promotion stays in `verifyImprovement` and `assessDeployment`, which do not by themselves change the production model.

The stored run already has `base_sha256`, `adapter_sha256`, benchmark version, and the decoding object. Item rows store raw output, `task_correct`, and `format_valid`. They do not store thinking mode, retrieval, tools, truncation, extractor version, or a configuration fingerprint.

A second body of evidence lives in `services/training/results/`, including `services/training/results/m75c/phase1a/REPORT.md`. Those files are not `evaluation_runs`. Phase 1A separates a 32-token cap from a 128-token cap and Prompt A from Prompt B. The colony rows inspected during M8 use `maxTokens: 8` and a Gemma base hash prefix `0e2acba196efd538`.

`verifyImprovement` could previously treat a stored accuracy drop as `VERIFIED_REGRESSION` without checking that the two sides shared a token limit, prompt, or scorer. The learning-service call now requires the stored contract to say the pair is comparable. Callers that omit `comparisonEligible` keep the previous policy, so existing unit tests of that policy stay intact.

## 3. Canonical manifest

Version: `m8.2-evaluation-contract-v1`. Schema: `evaluationManifestSchema` in `packages/core/src/evaluation/manifest.ts`.

Each controlled field is `set`, `unknown`, `omitted`, or `disabled`. Unknown is not treated as a match. Omitted matches omitted. Disabled matches disabled.

The manifest carries model family, identifier, human alias, checkpoint id, checkpoint digest, adapter id, adapter version, adapter digest, quantization, backend id and version, benchmark id and version, item-set fingerprint, item count, prompt and system-prompt ids and digests, scorer and extractor ids and versions, harness version, max output tokens, temperature, top-p, seed, thinking, stop sequences, context window, tools, retrieval, run id, timestamp, environment, git commit, status, and provenance.

New colony runs fill these from the trainable record, adapter record, and benchmark version. Thinking is `disabled`, tools are `unavailable`, and retrieval is `closed_book` because `predict` does not send those controls. Git commit is `unknown`. The alias is stored separately from the checkpoint digest.

## 4. Fingerprints and versioning

`configurationFingerprint` is the SHA-256 of the canonical JSON of contract version, quantization, backend, evaluation identity, and generation settings. Run id and timestamp are excluded. Model and adapter identity are excluded so that a model comparison can share a configuration fingerprint.

`itemSetFingerprint` is the SHA-256 of item id plus content digest, sorted by id. For a colony benchmark this uses the existing version `contentHash`, which already digests ordinal, prompt hash, and expected answer. It proves those recorded inputs matched. It does not prove the scorer is correct or that a file path points at the intended weights.

`contentDigest` hashes the supplied text. Filesystem paths are not hashed as model content.

## 5. Comparability rules

`compareManifests` returns `comparable`, a design (`strict`, `qualified`, `noncomparable`, or `indeterminate`), reasons, matched fields, differing fields, missing fields, allowed model or adapter differences, confounders, whether a paired comparison is possible, and whether a baseline re-evaluation is required.

Strict comparison requires the benchmark item set, prompts, scorer, extractor, harness, max output tokens, temperature, top-p, thinking, retrieval, tools, quantization, and backend to be known and equal. Model family, checkpoint, and adapter may differ and are listed as allowed differences. Quantization and backend differences are confounders. They fail a strict comparison. A qualified design can accept only those confounders, and only when the caller names them. Token limits, prompts, item sets, and scorers cannot be waived.

`comparable` is true only when that design's requirements are met. `POST /api/v1/evaluations/compare` calls this function and, when items are supplied, `analyzePairedRuns`. It has no other comparison path.

## 6. Failure classification

`classifyItem` keeps task correctness, output validity, execution validity, and truncation separate. An invalid format does not become a reasoning grade. A scorer, generation, timeout, or tool failure does not become an incorrect answer.

Truncation is `confirmed` only when termination is `length` or the caller supplies confirmed termination evidence. `suspected` is used only when the caller supplies that status. Unknown or omitted termination stays `indeterminate`. Answer text is not used as truncation evidence.

`summarizeItems` reports attempted items, validly evaluated items, correct and incorrect items, format failures, extraction failures, confirmed and suspected truncations, infrastructure failures, coverage, end-to-end success over every attempted item, and conditional accuracy over validly evaluated items. Failures stay in the end-to-end denominator. Original item booleans are not replaced.

## 7. Statistical methods and assumptions

`analyzePairedRuns` refuses a verdict other than `noncomparable` or `insufficient_evidence` when the manifests are not comparable. On a comparable pair it aligns items by id and content digest, rejects duplicate ids, and runs exact McNemar only on items that are valid on both sides. Invalid items are counted as missing pairs, not as wrong answers.

The paired interval is a Wald interval for `(improved - regressed) / n`. Each marginal accuracy also has the existing Wilson interval. Significance requires the McNemar p-value to be below `alpha / familySize` and the Wald interval to exclude zero. `familySize` defaults to 1. A larger family applies a Bonferroni adjustment. No topic taxonomy is included.

An improvement verdict requires a positive difference whose interval is above zero. A regression verdict requires a negative difference whose interval is below zero. Otherwise the result is inconclusive. Inconclusive is not equivalence. The result always sets `deploymentAuthorization` to `separate_decision_required`.

Assumptions: items are independent, the pair is the same item under two conditions, and only jointly valid binary outcomes enter McNemar. Repeated samples of one item are not independent observations; duplicate item ids are rejected.

## 8. Historical compatibility

Checked from the M8 audit and `services/training/results/m75c/phase1a/REPORT.md`. The files were not modified and the models were not rerun.

| Pair | Result |
|---|---|
| Gemma colony runs at 8 tokens versus Qwen files at 32 or 128 tokens | Not comparable. Token limit differs. The recorded base hashes also differ. |
| Qwen 32-token versus Qwen 128-token, same prompt | Not a strict match. The token limit differs. Phase 1A already treated these as different budgets. |
| Prompt A versus Prompt B at 128 tokens | Not comparable. The prompt digest differs. |
| Colony rows whose decoding is only `{ strategy, maxTokens, temperature }` | Indeterminate. Thinking, retrieval, tools, extractor, and harness are unknown. They are not filled in. |
| Same colony harness with a different adapter digest | Comparable. The adapter difference is allowed. |

The Phase 1A report gives the historical base 134/300 at 32 tokens with 212 truncations, and 291/300 at 128 tokens on the same prompt. Those numbers describe two budgets. This milestone does not turn either number into a forgetting or improvement claim.

A read-only check on `127.0.0.1:5433` saw `transaction_read_only = on` and data directory `/tmp/ai-colony-pg`. `evaluation_runs` has 5 rows, all with `maxTokens` 8. `evaluation_item_results` has 100 rows. Those rows were not updated.

## 9. Source-code changes

New modules under `packages/core/src/evaluation/`:

- `manifest.ts`: schema, `parseEvaluationManifest`, `contentDigest`, `itemSetFingerprint`, `configurationFingerprint`
- `compare.ts`: `compareManifests`
- `classify.ts`: `classifyItem`, `summarizeItems`
- `paired.ts`: `analyzePairedRuns`
- `colony-manifest.ts`: `colonyRunContract`, `legacyManifest`, `readStoredContract`

Extended:

- `gate.ts`: `applyGateIfComparable` returns `INCONCLUSIVE` without an accuracy verdict when the pair is not comparable. `decideGate` is unchanged.
- `improvement.ts`: `comparisonEligible: false` returns `EVALUATION_INVALID` before any improvement or regression classification.
- `evaluation-service.ts`: new runs store the contract. `decide` uses it. `compare` is the API entry.
- `learning-service.ts`: improvement verification passes `comparisonEligible` from the stored contract.
- `apps/api/src/routes/evaluation.ts`: `POST /api/v1/evaluations/compare`
- `tests/unit/evaluation-contract.test.ts`

## 10. Test results

`pnpm exec vitest run --config vitest.unit.config.ts`

- 24 files, 119 tests passed, 0 failed, 0 skipped

`tsc -p tsconfig.typecheck.json --noEmit` passed. ESLint passed on the M8.2 files.

The new tests cover schema validation, stable fingerprints, missing metadata, different models and adapters, different item sets, prompts, token limits, scorers, and retrieval, confirmed versus suspected truncation, paired alignment, the exact McNemar values `2/2^30` and `1`, Wald endpoints, synthetic improvement, regression, and null cases, noncomparable runs, legacy unknown fields, and the fail-closed gate.

Integration tests were not run. Their setup uses port 5433 and can start Docker Compose.

## 11. Migrations

None written. None applied. The manifest fits in the existing `evaluation_runs.decoding` JSON and `evaluation_reports.summary` JSON. Historical rows stay valid. A run without `evaluationContract` is interpreted by `legacyManifest` as partial evidence.

## 12. Remaining limitations

- Historical colony rows do not gain thinking, retrieval, truncation, or harness fields. Comparisons that need those fields stay indeterminate until a new evaluation is recorded.
- The M7.5 files are not imported into `evaluation_runs`. Their scores are not paired inside the database.
- `gradeArithmetic` is still the colony scorer. The contract can name a different scorer version, but it does not re-score historical text.
- `decideGate` can still FAIL a comparable arithmetic drop. It is not asked to judge a noncomparable pair.
- `verifyImprovement` without `comparisonEligible` keeps its previous behavior. The learning-service path sets the flag.
- No topic taxonomy exists. Multiple-testing support is only the `familySize` input.
- A significant paired result does not authorize promotion.
- The API compare route was typechecked and was not called against a running server.

## 13. Database and model safety

Canonical PostgreSQL was not modified. The only database session in this milestone was `BEGIN READ ONLY` on `127.0.0.1:5433` / `ai_colony`. `SHOW transaction_read_only` returned `on`. `SHOW data_directory` returned `/tmp/ai-colony-pg`. Port 5434 was not contacted.

No model was trained, loaded, unloaded, downloaded, or prompted. Ollama was not stopped or reconfigured. Qwen3-8B, department assignments, adapter artifacts, and historical reports were not changed. Nothing was deployed.

## 14. Readiness for M9

M9 can call `parseEvaluationManifest`, `compareManifests`, and `analyzePairedRuns` instead of comparing raw accuracies. `POST /api/v1/evaluations/compare` exposes the same functions.

M9 was not started. A department capability ledger still needs a topic taxonomy, which this milestone does not add. The ledger must not treat the 8-token Gemma runs and the 32-token or 128-token Qwen files as one capability measurement.

## 15. Public contract for M9

Manifest version `m8.2-evaluation-contract-v1`.

Comparison result:

- `comparable: boolean`
- `design: "strict" | "qualified" | "noncomparable" | "indeterminate"`
- `reasons`, `matched`, `differed`, `missing`, `allowedDifferences`, `confounders`
- `pairedComparisonPossible`, `baselineReevaluationRequired`
- `configurationFingerprint.left` and `.right`

Paired analysis adds `verdict` (`improvement`, `regression`, `inconclusive`, `noncomparable`, `insufficient_evidence`, `invalid_evaluation`), pair counts, accuracies, absolute and relative differences, Wilson intervals, a Wald paired interval, `pValue`, `alpha`, `familySize`, `adjustedAlpha`, and `deploymentAuthorization: "separate_decision_required"`.

Item classification:

- `taskCorrectness`: `correct | incorrect | unknown`
- `outputValidity`: `valid | invalid_format | extraction_failure | unknown`
- `executionValidity`: `valid | generation_error | timeout | tool_or_retrieval_failure | scorer_failure | incomplete`
- `truncation`: `confirmed | suspected | none | indeterminate`
