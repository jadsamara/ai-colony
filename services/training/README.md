# Training worker

This directory is the allowlisted MLX-LM worker for one local experiment: LoRA on Gemma 3 270M, structured arithmetic, Apple Silicon. The Node control plane launches `train_lora.py`, `eval_lora.py`, and `generate_lora.py`. It does not accept a shell command from a model.

Production chat stays on `qwen3:8b` through Ollama. This worker does not call Ollama, does not merge an adapter into the base checkpoint, and does not change the Qwen registry row.

## Install

Use the Python 3.13 virtualenv in this directory. System Python 3.15 can import MLX but does not have a compatible `mlx-lm` install.

```bash
python3.13 -m venv services/training/.venv
services/training/.venv/bin/pip install -r services/training/requirements.txt
```

Pinned stack used here: `mlx==0.32.4`, `mlx-lm==0.32.2`, `mlx-metal==0.32.4`. The process must see the Metal GPU. A sandboxed or headless session reports "No Metal device available" and cannot train.

## Checkpoint

The trainable base is `mlx-community/gemma-3-270m-it-bf16`.

- Family `gemma-3`, architecture `gemma3_text`, 18 layers, hidden size 640, vocab 262144, context 32768
- License: Gemma
- Weights: `model.safetensors`, about 831 MiB, under the one-gigabyte local limit
- Place it at `services/training/checkpoints/gemma-3-270m-it-bf16/`

The published name is Gemma 3 270M. The safetensors index reports 435,870,336 stored parameters because the embedding and output matrices are included. The colony registry keeps the seeded identity of 270,000,000 and does not relabel the file as Qwen. Adapters from this checkpoint do not transfer to Qwen.

Do not download a multi-gigabyte checkpoint for this milestone. The 4-bit sibling is smaller, but the bf16 file is the trainable base so the original weights stay intact.

## Dataset

`POST /api/v1/training/datasets` with `source: "curated_arithmetic"` builds addition and multiplication examples whose answers are computed in the control plane. Commutative paraphrases share one group key. A hash of the group key and the split seed assigns train, validation, or test. A group that was already held out stays in test. `train.jsonl` and `valid.jsonl` are the only files the trainer sees.

Model-generated, disputed, superseded, archived, and unvalidated memories are excluded. A memory or objective trace is eligible only when the expression recomputes to the recorded answer.

Acceptance criteria are sealed with the dataset: numeric correctness must strictly improve, structured validity must be 1, and a lower training loss is ignored.

## Approval and a run

Set `TRAINING_PROVIDER=mlx` and `TRAINING_PYTHON` to the venv interpreter only for a real run. Tests ignore those variables and use the scripted provider.

1. An administrator registers the checkpoint with the SHA-256 of `model.safetensors`. The file must sit under `services/training/checkpoints`.
2. Weight Optimization, or another proposer, creates the dataset and proposes `gemma3-270m-math-v1`.
3. An administrator who did not create the run as an agent calls `POST /api/v1/training/runs/:id/approve`. That is the authorization record. Nothing trains before it.
4. The same administrator calls `POST /api/v1/training/runs/:id/execute`.

The allowlisted profile is rank 8, scale 2, dropout 0, AdamW, learning rate 0.0001, batch size 1, sequence length 256, 40 steps, last 4 layers, `q_proj` and `v_proj`. One job at a time. Runtime cap is 20 minutes. Artifact storage cap is 200 MB. One retry reuses the same run id.

`scripts/run-m5-training.ts` performs that sequence against the canonical database after `pnpm db:migrate` and `pnpm db:seed`.

## Evaluation and experimental inference

`POST /api/v1/training/runs/:id/evaluate` scores the frozen baseline and the candidate on the same held-out prompts with greedy decoding and an 8-token cap. The candidate process loads `adapters.safetensors` and checks its checksum. A second candidate pass records output variability. The evaluation row is insert-once.

Promotion (`POST /api/v1/models/candidates/:id/promote`) is allowed only after that evaluation meets the sealed criteria. It marks the candidate approved for experimental inference. It does not change `models.status` or `artifact_uri` for Qwen or Gemma, and it does not point the colony router at the adapter.

`POST /api/v1/models/experimental-inference` calls `generate_lora.py` for an approved candidate. Baseline scoring calls `eval_lora.py`, which never loads an adapter.

## Artifacts, cancellation, and recovery

Adapters are stored under `services/training/artifacts/runs/<run-id>/adapters.safetensors`. The database stores the relative path, byte size, SHA-256, and trainable parameter count. Example rows, artifact rows, and evaluation rows reject updates.

`POST /api/v1/training/runs/:id/cancel` writes a `cancel` file. The trainer checks it between reports and stops without starting a second run. If the API process restarts while a job is `preparing`, `training`, or `evaluating`, startup marks that job failed or cancelled and does not resume it. `POST /api/v1/training/runs/:id/retry` queues the same run again, up to the retry cap. `POST /api/v1/training/runs/:id/reproduce` creates a new run that still needs approval.

## Limits and troubleshooting

| Limit | Value |
| --- | --- |
| Steps | 200, profile uses 40 |
| Examples | 128 |
| Sequence length | 256 |
| Concurrent jobs | 1 |
| Runtime | 20 minutes |
| Artifact bytes | 200,000,000 |
| Retries | 1 |

`No Metal device available` means the process cannot see the GPU. Run it outside a sandbox. `ARTIFACT_MISMATCH` means the file hash does not match the registered checksum or the adapter is missing LoRA tensors. `NOT_ELIGIBLE` means the registry row is not Gemma 3 270M, including any attempt to point the trainer at Qwen. `BUDGET_EXCEEDED` means a second job was started or a cap was hit. `ACCEPTANCE_FAILED` means held-out numeric accuracy did not strictly improve. A lower training loss does not override that.

Observed duration and peak memory are stored on the run. They are not a GPU dollar cost.

## Recorded local run

`services/training/results/m5-gemma3-270m.json` is the control-plane record for run `7979740a-f163-4a42-b6f8-aa697a108f67`.

The base file `model.safetensors` is SHA-256 `0e2acba196efd538420b12060013cab1b11344fb8ebfd6a1c5813cafc2f79162` before and after training. The adapter `adapters.safetensors` is 329,376 bytes, SHA-256 `f6c44d975820f871c7929e82c3ea548cba66fc7ad3e6d33b7b15f06d2f28b6f4`, with 16 LoRA tensors and 81,920 trainable parameters on `q_proj` and `v_proj` in the last four layers. Training took 7.3 seconds, peak memory was about 0.95 GB, and the last reported losses were train 0.689 and validation 0.969. Qwen3-8B stayed `not_deployed` with a null artifact URI.

The sealed scorer passed: held-out whole-string numeric accuracy moved from 0 to 0.2, and every candidate string was an integer. That is one correct integer out of five (`0 + 10` -> `10`). The frozen baseline wrote equations and, on a reading of the number after `=`, already had the right value on three of those five items. The scorer does not parse equations, so those answers counted as misses. Experimental inference for `6 + 1` returned `11`. This run shows real parameter adaptation on a narrow task. It does not show general arithmetic improvement.

The original evaluation row stays as recorded. Milestone 6 scores the same five strings again with a separate equation-aware grader and does not update that row. A format gain does not offset an arithmetic miss, and five items cannot pass the later gate.

## Forgetting, backups, and restoration

Live forgetting clears the memory body and its embedding in the database that the API is using. It leaves a non-content audit event. It does not delete model weights, and it does not rewrite a database backup.

A dump taken before the forgetting request still contains the plaintext. Restoring that dump, or promoting a replica that was copied earlier, puts the content back into the live database. After a restore, run forgetting again and treat any adapter whose training examples cite that memory as contaminated until someone reviews it. Deleting the live row is not unlearning.
