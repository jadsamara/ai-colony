# C1.8D.1 — Development-only evaluation foundation package

Follows Gate v3 GPU PASS. Does **not** execute Stage B/C, locked tests, training, or adapter promotion.

## Scope

1. **Stratified Stage A pilot** — all 10 ID families × {easy, moderate, hard}; development only.
2. **Per-sample accounting** — `sampleSize = items × samplesPerProblem`; `pass@1` = mean over all samples; family × difficulty tables; math vs format; invalid-sample final responses after `</think>`.
3. **HF vs vLLM benchmark** — thinking-enabled, same pinned revision; throughput / VRAM / latency / tokens / outcomes. Official backend remains **huggingface-batched**.
4. **vLLM repeatability** — greedy + fixed-seed sampled same-config; one-at-a-time vs batched submit diagnostic. vLLM is **not** official unless repeatability passes.
5. **Projections** — GPU-hours scaled from measured wall-clock only (thinking-mode uncertainty bands).
6. **Reproducibility manifest** — model revision, eval version, decoding, batch size, dataset hashes, backend.

## Versions

| Component | Version |
|-----------|---------|
| Evaluation implementation | `c18d1-batched-eval-v5` |
| Accounting | `c18d1-accounting-v2` |
| Stratified selection | `c18d1-stratified-pilot-v1` |
| Official backend | `huggingface-batched` |
| Experimental backend | `vllm` |

## Evidence preservation

- Gate v1/v2 failures and Gate v3 PASS reports remain authoritative.
- Fresh `C18D1_OUT` for every GPU run; never overwrite prior reports.
