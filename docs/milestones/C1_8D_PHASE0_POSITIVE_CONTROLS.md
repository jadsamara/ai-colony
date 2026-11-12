# C1.8D Phase 0 — Positive controls

## Status

| Item | Status |
|---|---|
| Thresholds predeclared | Yes — `services/training/cuda/phase0/thresholds.json` |
| PEFT train/eval + chat-template masking | Implemented |
| Local Qwen3-0.6B smoke | **Operator-run on Mac** (script provided) |
| GPU Qwen3-8B controls | **PENDING — run on GPU VM; Cursor has no VM access** |
| Autonomous training flag | **Disabled** until `docs/milestones/C1_8D_PHASE0_GPU_RESULT.json` records a real pass |

Passing unit tests ≠ Phase 0 pass. Local smoke ≠ Phase 0 pass.

## Predeclared thresholds (do not edit silently)

- Memorization: exact-match ≥ **0.95** on the 8 trained SECRET_PAIR items; adapter must load; adapter weights must change.
- Generalization: held-out exact-match ≥ **0.90** on 24 unseen `REWRITE: wrap brackets` items **and** improvement over base ≥ **0.50**; adapter must load; weights must change.

## Local smoke (Mac)

```bash
cd /path/to/ai-colony
./scripts/c18d-phase0-local-smoke
# report: tmp/c18d-phase0/local-smoke/phase0-report.json
```

This may download `Qwen/Qwen3-0.6B` into the HF cache. It must not touch Ollama.

## GPU VM acceptance (operator)

```bash
cd /path/to/ai-colony
git pull
./scripts/c18d-phase0-gpu-controls
# report: tmp/c18d-phase0/gpu-controls/phase0-report.json
```

Record exact installed versions from the script stdout (`torch`, `transformers`, `peft`, CUDA device name).  
If `phase0Passed: true`:

```bash
cp tmp/c18d-phase0/gpu-controls/phase0-report.json docs/milestones/C1_8D_PHASE0_GPU_RESULT.json
git add docs/milestones/C1_8D_PHASE0_GPU_RESULT.json
git commit -m "Record C1.8D Phase 0 GPU positive-control pass."
```

Until that file exists with `mode=gpu-controls` and `phase0Passed=true`, `readAutonomousLearningFlags()` keeps autonomous training **off**.

## What Phase 0 proves / does not prove

- Proves: the HF PEFT pipeline can train an adapter that learns (memorization + simple generalization).
- Does **not** prove: Math algebra improvement, Weight Optimization decision quality, or readiness for autonomous cycles.
