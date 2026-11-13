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

## GPU batch-invariance observation (operator-reported; not claimed from Cursor)

- After the slicing fix: **18/24** exact text matches, **6** wording mismatches; **no** prefix/template artifacts.
- Divergences look like first-token / mid-text greedy wording flips under bf16; position_ids misalignment was not ruled out until gate v2 checks.

## Batch-invariance Gate v2 (preserved; GPU failed)

Pass required artifacts-free + aligned position ids + raw outcome/mathText agreement + `|Δlogit|≤5e-2`.  
Operator GPU run under commit `86fc7f7` **failed** (logit diffs ≈0.5–1.5 including padding-free rows; one false raw disagreement on equivalent `1281/26` vs `\frac{1281}{26}`). Keep those reports unchanged.

## Batch-invariance Gate v3 (current)

See `C1_8D_1_BATCH_INVARIANCE_GATE_V3.md`. Canonical SymPy answer agreement + graded-outcome agreement + same-config bs4 repeatability. Logit/KL diagnostics only (no hard logit threshold). Exact text reported, not required.

## Interval float/rational grading defect (grader v3.1)

**Finding:** For inequality expected `{kind:interval, left:-oo, right:-1/2, …}`, model answer `(-∞, -0.5)` was graded wrong under grader ≤v3 despite being mathematically correct.

**Root cause:** Interval grading used SymPy `Interval ==`. Endpoint `-0.5` parsed as `Float` while expected `-1/2` is `Rational`; those intervals are not `==`. Unicode `∞` already normalized to `oo` — this was **not** a documented `-oo/oo` format restriction.

**Fix (grader v3.1):** Parse endpoints via `nsimplify(..., rational=True)` and compare intervals with symbolic endpoint equality (`_intervals_equal`). Canonical keys prefer bracketed interval forms before Tuple expression parse.

**Historical:** Do not silently rescore prior reports; they remain under their recorded `graderVersion`. Fresh runs use `c18d1-grader-v3.1`.

## Repeatability gate coverage (agreement ≠ correctness)

Gate / vLLM repeatability pass criteria are **cross-run agreement** (graded outcome + canonical answer). They are not an accuracy gate:

- Two runs that both emit `(-∞, -0.5)` and both grade wrong (pre-v3.1) still **agree** → repeatability can pass.
- Exact-text mismatches without outcome/canonical disagreement are reported and do not alone fail.
- Batch one-at-a-time vs batched is a composition diagnostic, not alone decisive for official eligibility.
- `eligibleAsOfficialBackend=true` is a reproducibility signal only; official backend remains `huggingface-batched` until explicit promotion.

## Eval batching policy (`c18d1-batched-eval-v4`)

Batch size and batch composition are fixed per evaluation configuration. Base and adapter are always evaluated with identical batching. Item order, prompts, grader, decoding, and model revision are fixed for a given eval config.

## Versioning

| Component | Version |
|-----------|---------|
| Evaluation implementation | `c18d1-batched-eval-v4` |
| Batch-invariance gate (current) | `c18d1-batch-invariance-v3` |
| Batch-invariance gate (preserved) | `c18d1-batch-invariance-v2` |
| Grader (current) | `c18d1-grader-v3.1` |
| Grader (preserved) | `c18d1-grader-v3` / `c18d1-grader-v2` |
| Answer instruction | `c18d1-answer-instruction-v2` |

Prior Stage A pilot / gate reports must remain untouched; re-runs use fresh output directories.

## GPU acceptance

Batch-invariance and Stage A re-pilots require the Debian GPU VM. Cursor cannot invent those results. See `C1_8D_1_GPU_COMMANDS.md` §1.
