# C1.8D.1 — First training experiment (design only)

**Status:** Design document. **Not implemented. Not authorized to run.**  
Pinned model/revision/seeds/decoding remain unchanged until a separate approval.

## Hypothesis

Thinking-enabled Qwen3-8B (~95% on full-dev) can produce high-quality verified solutions on **training-only** algebra items that improve thinking-disabled Qwen3-8B on weak families, without regressing thinking-enabled behavior.

## Data separation

| Split | Use |
|---|---|
| New `train_only` generator stream | Teacher generation + student SFT |
| `id_dev` | Evaluation / noise floor / Stage B only |
| Locked ID/OOD + regression | Stage C with first adapter session only |

No overlap of prompts/answers with dev or locked streams (digest audit required before train).

## Pipeline (proposed)

1. Generate train-only items for weak families (+ optional mix of other ID families for non-regression).  
2. Teacher: thinking-enabled decode; collect final answers (and optionally traces for audit, not for student targets by default).  
3. Verify with SymPy + constraints; keep only `correct` under current grader.  
4. Reject invalid, truncated, grader_error, ambiguous multi-marker conflicts, unverifiable.  
5. Student SFT: thinking-disabled; target = verified `ANSWER:` payload only.  
6. Eval: thinking-disabled weak-family + overall; **mandatory thinking-enabled regression**.

## Success / failure (pre-register before launch)

- Family δ and multiple-comparison rules per `C1_8D_1_THINKING_NOISE_FLOOR_REVIEW.md`.  
- Overall non-regression (thinking-disabled and thinking-enabled).  
- Compute budget + kill switch.  
- Admin promotion gate only.

## Explicit non-goals

- No Stage C during this experiment’s train loop.  
- No promotion from family metrics alone.  
- No training on incorrect teacher outputs.
