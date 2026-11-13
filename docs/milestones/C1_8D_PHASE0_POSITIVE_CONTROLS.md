# C1.8D Phase 0 — Positive controls (v2)

## Status

| Item | Status |
|---|---|
| v1 thresholds / eval | **Superseded** — see `C1_8D_PHASE0_EVAL_AUDIT.md` + `C1_8D_PHASE0_V1_SUPERSEDED.json` |
| Thresholds v2 (declared before GPU) | `services/training/cuda/phase0/thresholds-v2.json` |
| Two-mode matched eval + invalid accounting | Implemented in `peft_lora_eval.py` / `peft_eval_common.py` |
| Hidden-rule generalization v2 dataset | 200 train / 100 held-out |
| Autonomous training | **Locked** until `C1_8D_PHASE0_GPU_RESULT_V2.json` records a real pass |
| GPU results in this Cursor session | **None reported** |

## Predeclared v2 thresholds

- Modes (identical for base and adapter):
  - `thinking_disabled` (`enable_thinking=False`, `maxNewTokens=64`)
  - `thinking_enabled` (`enable_thinking=True`, `maxNewTokens=1024`, extract after `</think>`)
- Base `invalidRate > 5%` ⇒ that mode’s evaluation is **invalid** (not a pass).
- Memorization: adapter exact-match ≥ 0.95 in **both** modes; evaluate base in both modes.
- Generalization v2: hidden reverse+`!` rule; held-out exact-match ≥ 0.90 **and** improvement over base ≥ 0.50 in **both** modes.

## GPU VM commands

### (a) Corrected two-mode re-evaluation of v1 adapters (diagnostic)

```bash
cd /path/to/ai-colony
git pull
export C18D_MEM_ADAPTER=/path/to/v1/memorization/train/adapter
export C18D_GEN_ADAPTER=/path/to/v1/generalization/train/adapter
./scripts/c18d-phase0-reeval-v1
# → tmp/c18d-phase0/reeval-v1/reeval-v1-report.json
```

This never unlocks autonomous training. Paste the report back for truncated/no-final-answer counts.

### (b) Corrected v2 controls (gate)

```bash
cd /path/to/ai-colony
git pull
./scripts/c18d-phase0-gpu-controls-v2
# → tmp/c18d-phase0/gpu-controls-v2/phase0-report-v2.json
# if phase0Passed=true:
cp tmp/c18d-phase0/gpu-controls-v2/phase0-report-v2.json docs/milestones/C1_8D_PHASE0_GPU_RESULT_V2.json
```

## Training/eval template alignment

- Training uses `enable_thinking=False` (final-answer supervision).
- Evaluation runs both modes explicitly and records `thinkingMode`, `maxNewTokens`, and `templateFingerprint` on every result.
