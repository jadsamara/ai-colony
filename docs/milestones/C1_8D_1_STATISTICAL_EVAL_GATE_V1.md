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
