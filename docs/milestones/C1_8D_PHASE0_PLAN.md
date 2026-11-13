# C1.8D Phase 0 — Plan (positive controls)

## Audit (reuse vs build)

| Area | Reuse | Build in Phase 0 |
|---|---|---|
| C1.8B/C experiment + sandbox | Spec, validation, read-only sandbox | Keep sandbox **GPU-disabled**; do not use it for Phase 0 training |
| MLX Gemma LoRA | Apple-only experimental path | Do not use for Qwen |
| CUDA dry-run stub | `train_lora_cuda.py` dry-run | New **PEFT** trainer/eval beside it |
| Registry / Ollama | Qwen3:8b serving identity | Train on **HF weights only**; never touch Ollama |
| DB | Existing audit append | No new tables; Phase 0 writes JSON reports under `tmp/` / `services/training/results/` |
| Autonomous scheduler | None yet | Flag defaults **disabled** until independently validated GPU v3 evidence passes |

## Phase 0 deliverables

1. Versioned thresholds (`thresholds.json` → v2 → v2.1 → **v3**). Preserve prior files unchanged.
2. Memorization + generalization datasets and a deterministic runner.
3. PEFT LoRA train/eval with chat template, prompt-token masking, EOS, adapter-load proof, weight-delta check.
4. Local smoke on `Qwen/Qwen3-0.6B` — **does not** pass Phase 0.
5. Exact GPU VM commands for `Qwen/Qwen3-8B` controls + load/train/eval timing + immutable fingerprints.
6. `autonomousTrainingEnabled: false` until independent v3 evidence validation succeeds (never unlock on report booleans alone).

## Later phases — Math / algebra evaluation

Evaluation algebra suite → Math accumulation → learning room → A/B/C train → records → scheduler.

### Algebra / Math evaluation requirements (prepare before large-scale runs)

1. **Batched evaluation first.** Implement batched evaluation with vLLM or batched Hugging Face generation before large-scale Math evaluation. Sequential single-example generate loops are not acceptable at suite scale.
2. **Matched baseline vs adapter configs.** Keep decoding, thinking mode, token budgets, templates, and stop criteria identical for baseline and adapter; record fingerprints.
3. **Thinking-mode alignment.** If Math normally uses thinking mode, ensure training data and training objectives support that mode, **or** explicitly train and evaluate both modes with the same honesty rules used in Phase 0.
4. **Regression coverage.** Include regression testing for general reasoning and thinking-mode behavior alongside algebra metrics.
5. **No Phase 0 transfer claim.** Do **not** treat Phase 0 synthetic-task success (memorization / hidden reverse+`!`) as evidence of improved mathematical reasoning.

## Gate history (brief)

| Spec | Gate idea | Outcome |
|---|---|---|
| v1 | Uncontrolled thinking / tiny `maxNewTokens` | Superseded (eval defects) |
| v2 | Both thinking modes + hard invalid cutoff | Superseded as gate |
| v2.1 | `thinking_disabled` gate + hard base invalid cutoff | Failed on validity cutoff despite strong adapter accuracy |
| v3 | Conservative bounds; skip thinking_enabled by default | Current gate; GPU not yet re-run in-repo |
