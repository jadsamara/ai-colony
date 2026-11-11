# C1.8B — Self-Training Engine Foundation

## Architecture audit (reuse)

| Area | Reuse | Gap |
|---|---|---|
| LoRA scripts | `services/training/{train,eval,generate}_lora.py`, `common.py`; allowlist in `training/paths.ts` | Scripts are **MLX / Apple** oriented; launcher rejects Qwen production targeting |
| Experiment planner | `TRAINING_METHODS`, `assertSafeConfig`, leakage checks | Methods assume `mlx-lm`; no CUDA/Blackwell trainer yet |
| Training service | Dataset sealing, propose/approve/execute, promotion gates | Execute path is Gemma/MLX experimental, not department Qwen3:8b adapters |
| Permissions | `training:*`, `learning:*`, `assertNotSelfDecision` | Sufficient for propose/validate; no new permissions required |
| Evaluation | C1.8A frozen suite + gates | Must stay frozen; C1.8B only references suite ids |
| Ollama depts | Live Qwen3:8b serving | **Do not modify**; serving ≠ training backend |

**Blackwell / Qwen3:8b:** Existing colony LoRA execution cannot train production Qwen3:8b on the GPU VM today. A future isolated CUDA (or other) trainer worktree is required. C1.8B allows `backend: "cuda-lora"` in the **spec** only; validation never launches it.

## Implemented

1. Typed, versioned experiment spec (`c18b-department-learning-v1`) with departments, skills, model identity/digest, datasets/provenance, training config, optional code patch, budgets, evaluation plan, approvals, artifacts.
2. Allowlisted training-code patch proposals + deterministic validation (path escape, syntax/dependency hooks, revision fingerprint). **No patch apply. No Python execution of trainers.**
3. Deterministic validation workflow (permissions, provenance, leakage, config, self-approval, code patch) producing an immutable result with `trainingLaunched: false`.
4. `SelfTrainingExperimentService` with responsibility map + audit append (no new tables).
5. Unit tests for the success and rejection cases listed in the milestone.

## Not implemented (remaining)

- Isolated Git worktrees applying patches
- Executing agent-modified LoRA code
- CUDA/Blackwell Qwen3:8b trainer
- Automatic weakness mining from C1.8A live reports
- Database schema for durable experiment rows (audit-only for now)
- Promotion or Ollama adapter swap

## Recommended next step

Stand up an **isolated training worktree** under an allowlisted root (copy of `services/training` + pinned base weights), apply a validated patch there, run `py_compile` + a dry-run trainer entrypoint on a disposable dataset, and keep artifacts outside production Ollama volumes. Only after that gate should Weight Optimization be allowed to enqueue a real LoRA job — still without touching live department serving containers.
