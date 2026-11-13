# C1.8D.1 — Development-only evaluation foundation package

Follows Gate v3 GPU PASS. Does **not** execute Stage B/C, locked tests, training, or adapter promotion.

## Scope

1. **Stratified Stage A pilot** — all 10 ID families × {easy, moderate, hard}; development only.
2. **Per-sample accounting** — `sampleSize = items × samplesPerProblem`; `pass@1` = mean over all samples; family × difficulty tables; math vs format; invalid-sample final responses after `</think>`.
3. **vLLM primary evaluation** — batched per-request seeds; statistical gate v1 (noise floor + cross-backend). HF batched is the independent reference.
4. **Noise floor** — identical-run ×2 both modes; MDI + flip rates (exact repeatability superseded for primary acceptance).
5. **Projections** — GPU-hours scaled from measured wall-clock only (thinking-mode uncertainty bands).
6. **Reproducibility manifest** — model revision, eval version, decoding, dataset hashes, backend, sampler implementation.

## Versions

| Component | Version |
|-----------|---------|
| Evaluation implementation | `c18d1-batched-eval-v6` |
| Accounting | `c18d1-accounting-v2` |
| Stratified selection | `c18d1-stratified-pilot-v1` |
| Primary backend | `vllm-batched` |
| Reference backend | `huggingface-batched` |
| Statistical gate | `c18d1-statistical-eval-v1` |
| Grader | `c18d1-grader-v3.1` |

## Evidence preservation

- Gate v1/v2 failures and Gate v3 PASS reports remain authoritative.
- Fresh `C18D1_OUT` for every GPU run; never overwrite prior reports.
