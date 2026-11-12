# C1.8C — Isolated Self-Training Code Execution

## Architecture audit (reuse)

| Area | Reuse | C1.8C addition |
|---|---|---|
| Experiment spec / validation | `department-learning-spec.ts`, `department-learning-validate.ts` | Requires validation approval before sandbox |
| Patch allowlist | `training-code-patch.ts` | Extended with `services/training/cuda/*`; still no host execution of agent code |
| Audit / permissions | `audit.append`, `training:execute` | Sandbox pass/fail audit events |
| MLX trainers | `services/training/*_lora.py` | Left unchanged; Apple-only path |
| Evaluation / Ollama | C1.8A frozen suite, live department serving | Untouched |

## Implemented

1. **Isolated workspace materialization** (`patch-apply.ts`): copies only allowlisted training files, applies unified diffs, rejects symlinks/binary/unauthorized paths, deletes the disposable workspace afterward.
2. **Restricted container runner** (`training-sandbox.ts`): Docker `--network=none`, read-only root, scratch/evidence mounts, CPU/memory/pids/time limits, capability drop, no GPU, no docker.socket, scrubbed env. Execution is **rejected** when isolation cannot be established.
3. **Syntax + dry-run smoke test**: `py_compile` then `services/training/cuda/train_lora_cuda.py --dry-run` inside the sandbox image.
4. **Blackwell-oriented trainer stub**: stdlib dry-run trainer with config manifest, Qwen3:8b alias support, LoRA fields, dataset refs, deterministic seed checks. **No weight download, no GPU training.**
5. **Department workflow** (`department-learning-workflow.ts`): Math / Weight Optimization / Memory / Engineering contributions with explicit `live_inference` vs `integration_boundary` labels.
6. **Evidence**: per-experiment `evidence.json` plus optional metrics/manifest copies; failed runs are recorded.
7. **Unit tests** covering success and the required rejection cases.

## Verified locally

- Unit tests with an injectable mock container runner (syntax + dry-run success path, rejection matrix, cleanup, audit evidence files).
- TypeScript project build.

## Not verified locally in this environment

- Real Docker daemon execution (client present; daemon socket permission / image build may be unavailable in the agent sandbox).
- Live department inference through Ollama (integration-boundary helpers are labeled; no pretended autonomy).
- CUDA/PyTorch installation or Blackwell GPU training.

## Remaining limitations

- Sandbox image `ai-colony-training-sandbox:c18c` must be built from `deploy/Dockerfile.training-sandbox` before real container runs.
- Torch/transformers/peft/trl versions are intentionally unpinned until the GPU VM stack is checked.
- No model promotion, no Ollama adapter load, no production DB migrations.
- `training:execute` remains the permission gate for launching sandbox smoke tests (system administrator today).

## Recommended next step

On the GPU VM: build the sandbox image offline, run one Engineering-approved patch through the real Docker runner, then pin a CUDA-enabled trainer image (still network-isolated, still no Ollama mounts) before any non-dry-run LoRA job.
