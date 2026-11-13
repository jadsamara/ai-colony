# C1.8D.1 — Batch-invariance Gate v3 GPU PASS

**Status:** PASSED on NVIDIA RTX PRO 6000 Blackwell  
**Commit:** `e8522dc`  
**Gate:** `c18d1-batch-invariance-v3`  
**Eval:** `c18d1-batched-eval-v4`

## Declared criteria (all met)

| Check | Result |
|-------|--------|
| `passed` | `true` |
| SymPy-canonical answer agreement | 24/24 |
| Graded-outcome agreement | 24/24 |
| Same-configuration `bs=4` repeatability | passed |
| Prefix/template artifacts | 0 |
| Position IDs aligned | all |

## Diagnostics (not acceptance thresholds)

| Metric | Value |
|--------|-------|
| Exact-text mismatches (`bs=1` vs `bs=4`) | 6/24 |
| First-token top-1 agreement | 22/24 |
| Max first-token \|Δlogit\| | 1.5 |
| Runtime | 94.028 s |

## Scientific note

Gate v3 **passed its declared criteria**. Batch-shape numerical differences (exact-text mismatches, logit deltas up to 1.5, top-1 disagreements on 2/24 items) **remain unexplained**. Do not treat this pass as proof of bitwise batch invariance.

## Historical preservation

- Gate v1/v2 failures and reports remain authoritative for those versions.
- This document records the successful v3 run; it does **not** overwrite or relabel prior evidence.
- Fresh output directories must be used for every subsequent gate or pilot run.
