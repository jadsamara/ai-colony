# C1.8D Phase 0 — Plan (positive controls)

## Audit (reuse vs build)

| Area | Reuse | Build in Phase 0 |
|---|---|---|
| C1.8B/C experiment + sandbox | Spec, validation, read-only sandbox | Keep sandbox **GPU-disabled**; do not use it for Phase 0 training |
| MLX Gemma LoRA | Apple-only experimental path | Do not use for Qwen |
| CUDA dry-run stub | `train_lora_cuda.py` dry-run | New **PEFT** trainer/eval beside it |
| Registry / Ollama | Qwen3:8b serving identity | Train on **HF weights only**; never touch Ollama |
| DB | Existing audit append | No new tables; Phase 0 writes JSON reports under `tmp/` / `services/training/results/` |
| Autonomous scheduler | None yet | Flag defaults **disabled** until both GPU controls pass |

## Phase 0 deliverables

1. Predeclared thresholds in `services/training/cuda/phase0/thresholds.json` (written before any training).
2. Memorization + generalization datasets and a deterministic runner.
3. PEFT LoRA train/eval with chat template, prompt-token masking, EOS, adapter-load proof, weight-delta check.
4. Local smoke on `Qwen/Qwen3-0.6B` (CPU; MPS if available) — **does not** pass Phase 0.
5. Exact GPU VM commands for `Qwen/Qwen3-8B` controls + throughput/VRAM capture.
6. `autonomousTrainingEnabled: false` until an operator-recorded Phase 0 pass report exists.

## Later phases (not in this commit)

Evaluation algebra suite → Math accumulation → learning room → A/B/C train → records → scheduler.
