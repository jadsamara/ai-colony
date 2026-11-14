# C1.8D — Full blind-audit preflight (CPU)

**Status:** Preflight fixes landed. **STOP — do not execute Gemma GPU audit / Stage B / training / promotion.**

## A. Remaining “grader defect” — polynomial_factorization:0042

Item: `c18d1-algebra-v2:development:polynomial_factorization:0042:38a978c18df8`  
Expected roots: `-15, 17, 20` for `p(x) = x**3 - 22*x**2 - 215*x + 5100`.

### Finding

The saved generation is an **incomplete / truncated** response: algebraic working begins, but **no usable final `ANSWER:` marker** is produced before the generation ends. Grader v3.4 is not failing to extract a valid final answer — there is none to extract.

Reconcile **v2** (`c18d1-grader-miss-reconcile-v2`) therefore classifies this as:

| Field | Value |
|---|---|
| `status` | `incomplete_or_truncated_response` |
| `openStageBBlocker` | **false** |
| Rationale | Truncation/incomplete ≠ grader defect |

Independent check similarly refuses to label truncated / no-marker outputs as `grader_miss`.

Original response text and historical audit fields are preserved on the reconcile sample (`rawPredictionPreserved`, `historicalOutcome`, `historicalClassification`).

### Not done

No grader v3.5 bump — no extraction defect was evidenced for a complete final answer.

## B. Audit composition — 325 vs design 307

Operator prepare reported **325** packets with **119** failures.

Accounting identity:

```
119 failures
+ ~188 stratified 10% regraded-correct samples   (= 307 − 119)
+ 18 exclusive high-risk corrects (outside 10%)  (= 325 − 307)
= 325 packets
```

| Question | Answer |
|---|---|
| Why +18 vs 307? | Selection now **always includes** high-risk `originalOutcome → corrected` transitions, even when they fall outside the stratified 10% correct sample. After dedup, **18** of those are exclusive. |
| All 119 failures included? | **Yes** — `select_audit_cases` adds every `wrong` / `invalid` / `truncated` / `grader_error`. |
| High-risk ∩ correct-sample overlap? | Yes, possible; flags merge on `(conditionId, itemId, sampleIndex)`. Counts reported as `highRiskAndCorrectSampleOverlapCount` vs `exclusiveHighRiskCorrectCount`. |
| 10% denominator? | Per `(conditionId, family)`: number of regraded `outcome=correct` rows; `k = max(1, round(denom × 0.10))` with `Random(18)`. |
| Unique by generation identity? | **Yes** — unique on `(conditionId, itemId, sampleIndex)`. |
| Reproducible with seed 18? | **Yes**. |
| Blind payload? | Reviewer sees only `problemStatement` + `rawModelResponse`. |

## Commands (CPU only)

```bash
./scripts/c18d1-full-blind-audit-prepare
# With live VM artifacts:
# C18D1_REGRADE_REPORT=…/offline-regrade-report.json \
# C18D1_WEAK_FAMILY_AUDIT=…/weak-family-audit-v2.json \
# ./scripts/c18d1-full-blind-audit-prepare
```

Do **not** set `C18D1_LLM_AUDIT_CONFIRM=1` / run `./scripts/c18d1-gpu-gemma-full-audit` without separate approval.
