# C1.8D.1 Stage A — Generation / grading audit

## Verified findings (from code + observed pilot artifacts)

1. **Left-padded batch slicing bug (primary).**  
   `batched_eval.py` v1 decoded `generated[row][attention_mask.sum():]`. With `padding_side="left"`, `attention_mask.sum()` is the *unpadded* token count, not the input sequence length passed to `generate`. For shorter rows in a batch, that slice starts inside the prompt suffix.  
   Qwen3's thinking-disabled chat template ends the generation prompt with an empty `<think>…</think>` block, so the contaminated decode often begins with `</think>` → classifier `unexpected_think_with_thinking_disabled`.  
   **Evidence:** pilot example starts with `</think>` then continues with normal working; `batch_size=1` would not hit this path because `sum(mask) == input_ids.shape[1]`.  
   **Fix (eval v2):** slice at `input_ids.shape[1]` via `generation_utils.slice_new_token_ids`.

2. **Answer contract mismatch (secondary).**  
   Pilot finals used `\boxed{ANSWER: \frac{9}{4}}`. The v1 line regex required a bare `^ANSWER:` line, so mathematically correct boxed/LaTeX finals became `no_answer_line` after think-protocol rejection or on clean rows.  
   **Fix (grader v2):** mathematical accuracy unwraps narrow wrappers; format compliance remains bare `ANSWER: <expression>`.

3. **Transformers 5.23 sampling kwargs (verified by GPU traceback).**  
   `model.generate(..., generator=torch.Generator(...))` raises  
   `ValueError: The following model_kwargs are not used by the model: ['generator']`  
   on transformers `5.23.0`. Thinking-enabled pilot never completed.  
   **Fix:** seed via `torch.manual_seed` / `cuda.manual_seed_all`; never pass `generator=`. Sampling uses per-item `generate` for RNG isolation.

4. **Chat-template boundary (code-path verified).**  
   `peft_chat.build_chat_texts(..., enable_thinking=False)` passes `enable_thinking` into `apply_chat_template` with `add_generation_prompt=True`. Qwen3 thinking-disabled templates place an empty think block in the *prompt*; generation must continue after that boundary. Decoding the prompt suffix is not a model thinking-mode failure.

## Hypotheses (not treated as proven)

- Residual true thinking-protocol violations may still occur after the slicing fix if the model emits think tags despite `enable_thinking=False`. Those must remain reported separately, not stripped.
- Greedy batched decode can still differ across batch sizes due to attention/position handling or nondeterministic CUDA kernels; the batch-invariance gate checks exact text on GPU (pending outside Cursor).

## Versioning

| Component | Version |
|-----------|---------|
| Evaluation implementation | `c18d1-batched-eval-v2` |
| Grader | `c18d1-grader-v2` |
| Answer instruction | `c18d1-answer-instruction-v2` |

Prior Stage A pilot reports must remain untouched; re-runs use fresh output directories.

## GPU acceptance

Batch-invariance and Stage A re-pilots require the Debian GPU VM. Cursor cannot invent those results. See `C1_8D_1_GPU_COMMANDS.md` §1.
