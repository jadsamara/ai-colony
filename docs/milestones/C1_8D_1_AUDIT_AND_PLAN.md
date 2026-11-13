# C1.8D.1 — Repository audit and implementation plan

## Status legend

| Label | Meaning |
|---|---|
| Implemented locally | Code/docs landed in this commit |
| Tested locally | Unit / CPU tests run on Mac |
| Pending GPU acceptance | Must be run on the Debian GPU VM |
| Completed GPU acceptance | Operator-confirmed on GPU (do not invent) |

## Audit — what already exists (reuse)

| Area | Location | Reuse for C1.8D.1 |
|---|---|---|
| Math department + agent | `packages/database/src/seed.ts` (`…000019`, agent `…000204`) | Subject department; **not** benchmark owner |
| Evaluation department + agent | seed `…000017` / `…000209` | **Owner** of locked benchmark access |
| Weight Optimization | seed `…000015` / `…000208` | Propose training later; **no** locked-item access |
| Monitoring / Memory | seed departments `…000013`, `…000016` | Observability / retention; no locked answers |
| Model registry | seed Qwen3-8B `…000101` | Serving identity stays Ollama-facing; training/eval use HF pins |
| C1.8A math suite | `packages/core/src/evaluation/math-suite.ts`, `math-baseline.ts` | Numeric calculator suite — **complement**, not replaced |
| Evaluation contract / Wilson / gates | `evaluation/manifest.ts`, `stats.ts`, `gate.ts`, DB evaluation repos | Reuse stats + report storage patterns |
| Learning API auth | `apps/api/src/routes/learning.ts`, Authorizer | Extend with locked-item gates; no parallel auth system |
| C1.8C sandbox | `packages/core/src/training/*sandbox*` | Unchanged; still GPU-disabled for colony sandbox path |
| C1.8D Phase 0 PEFT | `services/training/cuda/peft_*.py`, `phase0/` | Chat template, conservative bounds, timing patterns |
| Postgres / RabbitMQ / Ollama | existing compose + volumes | **Preserve**; do not reset |

## Gaps closed in this milestone

1. Immutable HF commit pinning with fail-closed baseline checks.
2. Independent SymPy algebra benchmark (10 ID + 3 structural OOD + regression).
3. Strict `ANSWER:` parser + adversarial tests.
4. Locked-test access control (Evaluation-only item-level).
5. Batched Hugging Face evaluator with checkpointing (vLLM deferred).
6. Stage A/B/C scripts and result templates.
7. Roadmap constraints for later learning phases (not implemented).

## Explicit non-goals (C1.8D.1)

- No autonomous Math training.
- No Weight Optimization decision automation.
- No new database / scheduler / registry / auth framework.
- No production Ollama changes.
- No claims of mathematical reasoning improvement from Phase 0.

## Phase 0 v3 note

Operator reports Phase 0 v3 GPU positive controls passed (`phase0Passed=true`) with strong conservative-bound results. **Copy the real VM report** to `docs/milestones/C1_8D_PHASE0_GPU_RESULT_V3.json` when available. This Cursor session does **not** invent that artifact. Autonomous training remains disabled for Math during C1.8D.1 even after Phase 0 eligibility.

## Architecture choice — batched eval

**Batched Hugging Face `generate`** is the default (`services/training/cuda/c18d1/batched_eval.py`).

Reasons:

- Fits existing PEFT/transformers stack.
- Avoids a new serving system beside production Ollama.
- Supports LoRA adapters via PEFT.

Introduce vLLM only if HF batching cannot meet throughput/VRAM needs; document memory impact before enabling.
