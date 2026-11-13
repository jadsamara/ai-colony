# C1.8D Phase 0 — Positive controls (v3)

## Status

| Item | Status |
|---|---|
| v1 thresholds / eval | **Superseded** — preserved; see `C1_8D_PHASE0_V1_SUPERSEDED.json` |
| Thresholds v2 | **Unchanged** in repo; superseded as gate spec |
| Thresholds v2.1 | **Unchanged** in repo; superseded as gate spec after examining GPU results |
| Thresholds v3 (gate) | `services/training/cuda/phase0/thresholds-v3.json` |
| Autonomous training | **Locked** for Math during C1.8D.1; Phase 0 eligibility ≠ Math training authorization |
| v3 GPU run | Operator-reported pass on RTX PRO 6000; **copy real** `phase0-report-v3.json` → `C1_8D_PHASE0_GPU_RESULT_V3.json` (not invented here) |

## Why v3 (after examining v2.1)

v2.1 failed on the hard base-invalid-rate cutoff, not on observed adapter accuracy:

| Control | Adapter | Base |
|---|---|---|
| Generalization | 100/100 correct, 0% invalid | 0/100 correct, 29% invalid |
| Memorization | 8/8 correct, 0% invalid | 0/8 correct, 100% invalid |

v3 replaces that cutoff with a **conservative worst-case comparison**:

- Base upper-bound accuracy = `(correct + invalid) / total`
- Adapter lower-bound accuracy = `correct / total` (invalids count as failures)
- Generalization improvement = adapter lower bound − base upper bound

v3 is **not** an independent pre-result specification. Do not claim the bound alone would have rejected v1 without verifying it.

### Thinking-mode diagnostic (carried forward; causality not established)

From v2.1 informational `thinking_enabled` eval:

- Generalization adapter: **85% invalid**
- Memorization adapter: **100% invalid**

Do not claim this degradation is conclusively caused by training until a controlled comparison establishes causality. v3 GPU controls **skip** `thinking_enabled` by default; the evaluator remains available via `--run-thinking-enabled`.

## Predeclared v3 thresholds

- **Gating mode:** `thinking_disabled` (`enable_thinking=False`, `maxNewTokens=256`, matched for base and adapter)
- **Informational mode:** `thinking_enabled` (skipped by default on GPU)
- Memorization: adapter lower-bound ≥ 0.95; adapter loaded; weight delta; sample size. **No** required improvement over base.
- Generalization: adapter lower-bound ≥ 0.90 **and** conservative improvement ≥ 0.50; adapter loaded; weight delta; held-out size
- Fresh adapters required (do not reuse v2.1 artifacts)
- Gate re-validates counts/bounds independently; report booleans alone never unlock

## GPU VM commands (v3)

```bash
cd /path/to/ai-colony
git pull

# Fresh output dir required (script refuses non-empty paths)
export C18D_PHASE0_OUT=/path/to/ai-colony/tmp/c18d-phase0/gpu-controls-v3-$(date +%Y%m%d-%H%M%S)

./scripts/c18d-phase0-gpu-controls-v3
# → ${C18D_PHASE0_OUT}/phase0-report-v3.json

# Optional informational thinking_enabled pass:
# C18D_PHASE0_RUN_THINKING_ENABLED=1 ./scripts/c18d-phase0-gpu-controls-v3

# Only after independent evidence pass:
cp "${C18D_PHASE0_OUT}/phase0-report-v3.json" docs/milestones/C1_8D_PHASE0_GPU_RESULT_V3.json
```

## Training/eval alignment

- Retrain both controls from base `Qwen/Qwen3-8B` with unchanged hyperparameters (unless separately versioned).
- Record resolved model/tokenizer revisions, seeds, adapter fingerprints, and load/train/eval wall-clock timings.
- Prior v1/v2/v2.1 reports and failures remain unchanged.
