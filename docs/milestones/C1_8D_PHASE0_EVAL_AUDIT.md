# C1.8D Phase 0 — Evaluation audit (v1 superseded)

## Gate status

**`autonomousTrainingUnlocked` remains false** until corrected **thresholds v2.1** controls pass on the GPU VM (`thinking_disabled` gating; `thinking_enabled` informational only). Thresholds v2 remains in-repo unchanged but is superseded as the gate spec.

Any prior v1 GPU report (if recorded) is **historical only** and is marked superseded in `docs/milestones/C1_8D_PHASE0_V1_SUPERSEDED.json`. Do not edit original result payloads.

## Code audit of v1 evaluation

| Setting | Training (`peft_lora_train` / `peft_chat`) | Evaluation (`peft_lora_eval` / `run_phase0`) | Match? |
|---|---|---|---|
| Chat template | `apply_chat_template` (default kwargs) | same helper, default kwargs | Partial — neither passed `enable_thinking` |
| Thinking | Implicit tokenizer default (Qwen3 often **on**) | Implicit default; generations observed starting with `<think>` | Uncontrolled |
| `maxNewTokens` | N/A (teacher-forced labels) | **24** in `run_phase0.py` | Eval budget too small for thinking |
| Answer extraction | Trains on bare assistant strings (no `</think>`) | Compared raw decode to expected; no `</think>` split | **Mismatch** when thinking is on |
| Invalid vs wrong | N/A | None — truncated/`<think>`-only counted as wrong | Missing |

### Implications

1. With thinking left on and `maxNewTokens: 24`, base (and often adapter) outputs that begin with `<think>` are almost certainly **truncated before a final answer**. Those rows are not valid exact-match failures of the rewrite rule; they are **invalid evaluations**.
2. Without Cursor access to the operator’s GPU artifact files, per-run truncated/no-final-answer **counts must be produced by re-running** the corrected two-mode re-eval on the VM (`./scripts/c18d-phase0-reeval-v1`). This audit records the defect; it does not invent percentages.
3. If a fairly evaluated base model (thinking off, or thinking on with a full budget + `</think>` extraction) already scores high on the v1 “wrap brackets” control, the original 0%→100% style comparison is **not evidence of generalization**. Adapter weight-delta and adapter-load checks remain valid **training-mechanics** evidence only.

## Corrective design (committed before GPU re-runs)

1. Shared eval runner records `thinkingMode`, `maxNewTokens`, and template fingerprint on every result.
2. Two matched modes for base and adapter: thinking **disabled**; thinking **enabled** with a large budget + final-answer extraction after `</think>`.
3. Predictions classified as `correct` | `wrong` | `invalid` (truncated / no final answer / empty). If base `invalidRate > 5%`, that mode’s evaluation is **invalid**, not a pass.
4. Thresholds **v2** + hidden-rule generalization dataset (no instruction text in the input).
5. Thresholds **v2.1** (before any v2 GPU run): gate on `thinking_disabled` only — adapters train with `enable_thinking=False`, so thinking-enabled eval is OOD for the gate; raise informational `maxNewTokens` to 4096.
