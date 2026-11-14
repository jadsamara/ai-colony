# C1.8D — Gemma 3 27B Instruct blind-audit reviewer proposal

**Status:** Proposed. **GPU workload NOT authorized.** **STOP for approval.**

Replaces the prior GPT-4o-mini API proposal with **local** `google/gemma-3-27b-it` on the RTX PRO 6000 Blackwell 96 GB via vLLM.

## Why Gemma

| Requirement | Proposal |
|---|---|
| Different family from Qwen3-8B | Gemma 3 (`gemma3`) ≠ `qwen3` |
| Local 96 GB GPU | BF16 weights ~54 GiB + KV headroom at `max_model_len=4096` |
| Blind audit design | Unchanged: ~307 cases; all non-correct + stratified 10% corrects |
| Ground truth | SymPy / `independent_check` adjudicate; Gemma never authoritative |

## Pinned revision

- Model: `google/gemma-3-27b-it`
- Revision: `005ad3404e59d6023443cb575daa05336842228a`
- Gated HF license — set `HF_TOKEN` after accepting Google’s Gemma terms

## Compatibility (operator checks — no auto-run)

1. `vllm >= 0.8.3` (recommend ≥0.8.5 for Gemma 3 text path)
2. `transformers >= 4.50.0`
3. Same Blackwell CUDA stack already serving Qwen in `.venv-vllm`
4. **Fully exit** Qwen vLLM (process exit; ~88 GiB KV) before loading Gemma
5. `nvidia-smi` shows sufficient free memory

## Preferred serving (BF16)

Config id: `c18d1-gemma3-27b-it-vllm-bf16-v1`

- `--dtype bfloat16`
- `--gpu-memory-utilization 0.85`
- `--max-model-len 4096`
- `--max-num-seqs 32`
- `--limit-mm-per-prompt image=0` (text-only audit)
- `--host 127.0.0.1 --port 8001`

**Fallback (only if BF16 OOM / unsupported):** AWQ quantized config `c18d1-gemma3-27b-it-vllm-awq-v1` — must re-pin AWQ revision and re-pass smoke validation.

Exact command printer:

```bash
cd ~/ai-colony && git pull --ff-only
python3 services/training/cuda/c18d1/reviewer_gemma3.py
```

## Smoke validation (before full 307)

CPU fixture builder (no GPU):

```bash
python3 services/training/cuda/c18d1/gemma_smoke_validation.py \
  --out /tmp/c18d1-gemma-smoke
```

12 independently verified packets (6 correct incl. `2**-40` / `2**-24` / `2**63`, 6 incorrect/insufficient).  
Pass bar: ≥10/12 reviewer judgments agree with independent truth; SymPy wins disagreements.

## Runtime / cost estimate (307 cases)

| Item | Estimate |
|---|---|
| Model load | ~4 min |
| Smoke (12) | ~1–2 min |
| Full audit generation | ~13 min @ 2.5 s/case batched |
| **Total GPU time** | **~0.3–0.5 GPU-hours** |
| API USD | **$0** (local) |

Recompute after smoke with measured tok/s before approving full audit.

## Execution plan (after approval only)

1. Compatibility checks pass  
2. Tear down Qwen engine  
3. Serve Gemma BF16 (pinned revision)  
4. Smoke validate → **STOP if fail**  
5. Full blind 307-case audit; record revision, serve config, prompt, judgments  
6. Adjudicate with SymPy; human escalate unresolved  
7. Tear down Gemma before any Qwen Stage work  

## Smoke deployment (approved — 12 cases only)

Cursor cannot access the GPU VM. On the Debian host:

```bash
cd ~/ai-colony && git pull --ff-only
export HF_TOKEN=…   # gated access to google/gemma-3-27b-it
export C18D1_VLLM_PYTHON=~/ai-colony/tmp/c18d1/.venv-vllm/bin/python
export C18D1_OUT=~/ai-colony/tmp/c18d1/gemma-smoke-$(date +%Y%m%d-%H%M%S)
# Only if no active Qwen eval/train and you intentionally stop listeners:
# export C18D1_STOP_EXISTING_VLLM=1
./scripts/c18d1-gpu-gemma-smoke
# review: $C18D1_OUT/gemma-smoke-report.json
# server is stopped on exit
```

Pass bar: ≥10/12 agree with independent truth and ≥10/12 parseable JSON.  
**Do not** run the 307-case audit until a separate approval after reviewing smoke metrics.

## Explicit non-starts

- Do **not** run the full 307-case audit without separate approval  
- Do **not** start stratified pilot, Stage B, training, Stage C, or promotion  
- Do **not** change official grades from Gemma judgments alone  

Code: `reviewer_gemma3.py`, `gemma_smoke_validation.py`, `gemma_smoke_runner.py`, `scripts/c18d1-gpu-gemma-smoke`.
