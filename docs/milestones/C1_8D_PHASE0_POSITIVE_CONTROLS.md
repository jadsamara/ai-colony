# C1.8D Phase 0 — Positive controls (v2.1)

## Status

| Item | Status |
|---|---|
| v1 thresholds / eval | **Superseded** — see `C1_8D_PHASE0_EVAL_AUDIT.md` + `C1_8D_PHASE0_V1_SUPERSEDED.json` |
| Thresholds v2 (both modes gated) | **Superseded as gate spec** — kept unchanged at `thresholds-v2.json` |
| Thresholds v2.1 (gate) | `services/training/cuda/phase0/thresholds-v2.1.json` |
| Two-mode matched eval + invalid accounting | Implemented in `peft_lora_eval.py` / `peft_eval_common.py` |
| Hidden-rule generalization v2 dataset | 200 train / 100 held-out |
| Autonomous training | **Locked** until `C1_8D_PHASE0_GPU_RESULT_V2.json` records a real **v2.1** pass |
| GPU results in this Cursor session | **None reported** (no v2/v2.1 GPU run yet) |

## Why v2.1

Adapters are trained with `enable_thinking=False`. Gating on `thinking_enabled` is out of distribution for that adapter. v2.1 keeps matched thinking-enabled eval for diagnostics (accuracy + invalid counts, `maxNewTokens=4096`) but **only `thinking_disabled` affects the gate**, including `maxBaseInvalidRate`.

## Predeclared v2.1 thresholds

- **Gating mode:** `thinking_disabled` (`enable_thinking=False`, `maxNewTokens=64`)
- **Informational mode:** `thinking_enabled` (`enable_thinking=True`, `maxNewTokens=4096`, extract after `</think>`) — does not fail the gate
- Base `invalidRate > 5%` in the **gating** mode ⇒ evaluation invalid (not a pass). Informational invalid rate is reported only.
- Memorization (gating mode): adapter exact-match ≥ 0.95; adapter loaded; weight delta; sample size
- Generalization v2 (gating mode): held-out exact-match ≥ 0.90 **and** improvement over base ≥ 0.50; adapter loaded; weight delta
- `gpuGate.bothControlsMustPassInGatingMode: true`

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

### (b) Corrected v2.1 controls (gate)

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
- Evaluation still runs both modes with matched settings and records `thinkingMode`, `maxNewTokens`, and `templateFingerprint` on every result.
- Only the gating mode unlocks autonomous training.
