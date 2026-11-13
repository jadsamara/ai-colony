# C1.8D.1 — Statistical evaluation gate v1

**Gate version:** `c18d1-statistical-eval-v1`  
**Primary backend:** `vllm-batched`  
**Reference backend:** `huggingface-batched`  
**Adopted after:** greedy exact-repeatability proved unsuitable for vLLM continuous batching (historical repeatability reports preserved; not rewritten).

## Decision

vLLM is the **primary** evaluation backend for Stage A/B development baselines and all later base-vs-adapter evaluation. Hugging Face batched remains an **independent exact cross-check**.

Exact same-config text/outcome repeatability is **not** the acceptance criterion for vLLM.

## Batching contract

- All requests for a condition (per `sampleIndex`) are submitted in **one** `generate()` call.
- Each request uses its own `SamplingParams(seed=...)` from `sampling_seed_schedule(base, itemIndex, sampleIndex)`.
- One vLLM engine per run, reused across conditions; engine startup recorded separately from eval time.
- Thinking mode: **8192** new-token cap; truncation and missing-final-answer rates reported per family.
- Every report records `samplerImplementation` (FlashInfer vs native/unspecified).

## Noise floor

1. Evaluate the base model **twice** on the same development set with identical settings, both modes.
2. Report overall and per-family accuracy, absolute and paired differences, graded-outcome flip rates, and Wilson CIs.
3. Derive a **minimum detectable improvement (MDI)** with documented assumptions (see `paired_stats.minimum_detectable_improvement`).
4. Equal aggregate accuracies are **not** evidence of zero noise.

### Statistical methods v2 (`c18d1-paired-stats-v2`)

Primary inference units are **items**, not raw responses. Thinking-mode `samplesPerProblem=3` are clustered within item.

Distinguish four layers in every noise-floor report:

| Layer | Meaning |
|---|---|
| **Observed noise floor** | Measured item-level \|Δacc\| and item flip rates from the identical-run pair |
| **Variability CI** | Item-clustered paired bootstrap percentile CI on the **signed** mean accuracy difference |
| **MDI** | Planning minimum detectable improvement under α/power; discordant rate uses max(observed, Wilson upper, rule-of-three `3/n` when flips=0) so zero flips do **not** yield near-zero MDI |
| **Model promotion threshold** | `max(MDI, policy floor, bootstrap CI half-width)` — what adapters must beat |

`differenceWilson` on discordant composition is **deprecated** as a signed-difference CI. Prior reports under `c18d1-paired-stats-v1` are preserved (fresh `C18D1_OUT` for reruns).

### MDI 21.24% → 31.84% (item-level)

Under `c18d1-paired-stats-v2`, MDI is driven by **item** flip count \(n=24\), not response count:

| Item flips / 24 | Approx. MDI |
|---|---|
| 0 | **21.24%** (rule-of-three / Wilson floor on \(\pi_d\)) |
| 1 | 25.73% |
| 2 | 29.08% |
| 3 | **31.84%** |

So a rise from 21.24% to 31.84% means the latest identical-run pair had **3 items** with ≥1 graded-outcome disagreement (often in thinking mode under sampling), not a formula regression. Response-level tallies (e.g. 1/72) are diagnostic only; MDI uses `independentItemCount`.

### Cross-backend GPU sequencing

vLLM at `gpu_memory_utilization≈0.92` can reserve ~88 GiB of 96 GiB (large KV cache). Cross-backend **must** finish and exit the vLLM process before loading HF in `.venv-gpu`. See `shutdown_vllm_engine` and `scripts/c18d1-gpu-cross-backend` phases `vllm` → `hf` → `compare`.

## Configuration changelog (intentional)

| Change | Version | Note |
|---|---|---|
| Grader recognizes `\\text{ANSWER: ...}` | `c18d1-grader-v3.2` | Math may be correct while formatCompliant stays false; do not rescore old reports |
| Thinking-disabled `maxNewTokens` 512→2048 | `c18d1-decoding-v2` | v1 (512) preserved as `THINKING_DISABLED_V1` |
| HF report backend label | reference = `huggingface-batched` | Must never be labeled `vllm-batched` |
| Full-dev noise floor | same-seed + alternate-seed (thinking) | 24-item 21.24% MDI is **not** automatic promotion threshold; practical meaningful improvement is separate |

Base-vs-adapter comparisons use the **same seed schedule** and are judged against the **same-seed** noise floor.

## Adapter claims

- Base and adapter evaluated in the **same session**, same backend; adapter via vLLM LoRA.
- Thinking mode: ≥3 paired samples per item (increase if CIs remain too wide).
- Improvement must exceed MDI with paired McNemar + Wilson evidence.
- Do **not** promote when inconclusive.

## Cross-backend check

On a stratified development subset, |vLLM − HF| accuracy difference must fall within a tolerance informed by the measured noise floor. A nonsignificant McNemar p-value alone is **not** demonstrated equivalence.

## Gate pass criteria

Pass iff:

1. No unresolved prompt-template / prefix-caching / answer-extraction / request-alignment artifacts.
2. Identical-run flip rates measured and reported.
3. Baseline noise floor and uncertainty recorded.
4. Cross-backend agreement check passes.

On failure: retain evidence; report blockers; do not override.

## Stage C correction

Locked Stage C runs in the **same session** as the first trained adapter (base and adapter back-to-back). It is **not** run alone before that.

## Historical gates

| Gate | Status |
|---|---|
| `c18d1-batch-invariance-v2` | Preserved failure evidence |
| `c18d1-batch-invariance-v3` | Preserved PASS evidence (HF path) |
| vLLM exact repeatability | Historical; superseded for primary acceptance |
| `c18d1-statistical-eval-v1` | **Current** primary acceptance |
