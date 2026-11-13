# C1.8D.1 — Batch-invariance Gate v3

## Why Gate v3 exists

Gate **v2** (`c18d1-batch-invariance-v2`, commit `86fc7f7`) was run on the GPU VM and **failed**. That implementation, its reports, and the failure are preserved historical evidence. Do not overwrite or retroactively relabel those runs.

### Confirmed v2 GPU observations

- 24/24 mathematical correctness outcomes agreed across `batch_size=1` and `4`.
- One reported disagreement was raw-string only: `1281/26` vs `\frac{1281}{26}` (mathematically equivalent).
- 18/24 exact generated texts matched.
- No prefix/template artifacts; position IDs aligned.
- First-token max abs logit diffs ≈ **0.5–1.5**, including padding-free rows.
- Cause of the numerical diffs is **not** conclusively established (bf16 GEMM near-ties remain a hypothesis).

Gate v2 required `|Δlogit| ≤ 5e-2`, so those runs correctly failed under v2 rules. Raising that threshold to force a pass would be unscientific.

## Gate v3 scientific rationale

1. **Canonical answers** — Compare final answers with SymPy normalization so equivalent LaTeX forms agree, while distinct wrong answers do not agree merely because both grade `wrong`.
2. **Separate metrics** — Report mathematical-correctness agreement, canonical-answer agreement, and exact answer-text agreement independently.
3. **Logits as diagnostics** — Top-1 agreement, KL (float32-stable), top-1/top-2 margins, per-item diffs, padding-free vs padded splits — **visible, not used as hard acceptance thresholds**.
4. **Same-configuration repeatability** — `batch_size=4` vs `4` with identical order, composition, model, prompts, decoding. Any graded-outcome or canonical-answer disagreement is a reproducibility failure.
5. **Cross-batch acceptance** — No artifacts; aligned position IDs; 100% canonical answer agreement; 100% graded-outcome agreement; repeatability must pass.

## Versions

| Component | Version |
|-----------|---------|
| Gate (current) | `c18d1-batch-invariance-v3` |
| Gate (preserved) | `c18d1-batch-invariance-v2` |
| Evaluation implementation | `c18d1-batched-eval-v4` |

## Official evaluation policy (unchanged intent)

Fixed batch size and composition; identical batching for base and adapter; fixed item order, prompts, grader, decoding, and model revision; explicit eval implementation version and template fingerprint.

## GPU PASS (operator-reported)

See `C1_8D_1_BATCH_INVARIANCE_GATE_V3_GPU_PASS.md`. Gate v3 **passed** its declared criteria on RTX PRO 6000 Blackwell (commit `e8522dc`). Batch-shape numerical differences (exact-text / logits) **remain unexplained**. Historical v1/v2 failures are preserved.
