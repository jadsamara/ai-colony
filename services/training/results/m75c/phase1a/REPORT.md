# M7.5C Phase 1A — Training Failure Root-Cause Audit

## 1. Executive summary

Three facts are established. They are not three causes.

The installed MLX-LM 0.32.2 loss includes one padding target on the historical arithmetic sequences. For `19 * 16 * 2` with completion `608<|im_end|>`, the installed `default_loss` returned a loss-bearing count of 5. The four real completion tokens are `6`, `0`, `8`, and `<|im_end|>`. The fifth is padding id 0, which this tokenizer decodes as `!`. Replacing the inclusive upper bound with `steps < lengths[:, 1:]`, and keeping the prompt-offset lower bound, drops that token. Calling the installed function produced this count. Reading `<=` in the source was not the evidence. A corrected mask is implemented in an isolated research module and was not used for any optimizer step. This audit cannot assign that extra target a share of the accuracy drop.

The six M7.5 adapters suppressed intermediate working. On the stored sealed responses they emit a bare integer on 259 to 290 of 300 items, at about 3 to 5 tokens. Those strings reproduce byte for byte under the original prompt, greedy decoding, and a 32-token cap. The base model’s stored 134/300 is a worked-solution score with 212 of 300 responses cut off at 32 tokens. The same base, the same prompt, and a 128-token cap score 291/300, with zero truncations, and every response is the stored response or a continuation of it.

Allowing worked solutions raises the adapters’ correctness and leaves every M7.5 adapter below the base. At a shared 128-token cap the six adapters move from 27, 38, 38, 29, 35, and 54 to 173, 93, 222, 143, 127, and 254 out of 300. The base scores 291/300 on the original prompt and 258/300 on the worked-solution prompt. All six remain below both of those figures. The gain is a change in the extracted integer. The M7.5B structured adapters never moved to bare integers. On this same 300-item set, at 128 tokens, they score 290/300 against the base’s 291/300. Their stored 139/300 was measured at the 32-token cap, where the base on their own holdout scored 138/300.

No training was run. No adapter was created. No optimizer step was taken. The corrected loss was not applied to weights. Operational model assignments were not changed. Phase 1B was not started.

## 2. Historical score verification

Independent rescoring used `answer-extract-m75-v1` (last integer) through `research/m75/score.ts`. Every confirmatory sealed file matches the recorded count. There is no discrepancy.

| Study | Run | Rescored | Recorded |
| --- | --- | ---: | ---: |
| M7.5 | baseline-sealed | 134/300 | 134/300 |
| M7.5 | self-101-r1-sealed | 27/300 | 27/300 |
| M7.5 | supervised-101-sealed | 37/300 | 37/300 |
| M7.5 | self-202-r1-sealed | 38/300 | 38/300 |
| M7.5 | supervised-202-sealed | 29/300 | 29/300 |
| M7.5 | self-303-r1-sealed | 33/300 | 33/300 |
| M7.5 | supervised-303-sealed | 54/300 | 54/300 |
| M7.5B | baseline-sealed | 138/300 | 138/300 |
| M7.5B | structured-s5-n25-sealed | 139/300 | 139/300 |
| M7.5B | structured-s5-n25-seed-202-sealed | 139/300 | 139/300 |
| M7.5B | structured-s5-n25-seed-303-sealed | 139/300 | 139/300 |

These are observed accuracy differences. They are not a mechanism. The full check is `historical-verification.json`.

## 3. MLX-LM version and source identity

| Item | Value |
| --- | --- |
| mlx-lm | 0.32.2 |
| mlx | 0.32.4 |
| mlx-metal | 0.32.4 |
| Trainer path | `services/training/.venv/lib/python3.13/site-packages/mlx_lm/tuner/trainer.py` |
| SHA-256 of that file | `0b6027fdb11803e951ceee52c83a81f82daa922ea8c6b7ca6888953461064e8e` |
| Loss function | `default_loss` |
| Batch function | `iterate_batches` |
| EOS / `<\|im_end\|>` | 151645 |
| Padding cell written by `iterate_batches` | token id 0, decoded as `!` |

The installed mask is `steps >= lengths[:, 0:1]` and `steps <= lengths[:, 1:]`. `lengths[:, 0]` is the prompt offset. `lengths[:, 1]` is the unpadded token count. The loss is the masked cross-entropy divided by the sum of the mask. The venv file was not modified.

## 4. Token-level loss-mask audit

The reconstructed example is the historical integer-only user turn for `19 * 16 * 2`, with assistant text `608`, rendered with the chat template and the closed empty think block `<think>\n\n</think>\n\n`.

The rendered sequence has 42 tokens. The prompt occupies indices 0 through 37, so the completion offset is 38. `iterate_batches` pads a 42-token row to width 65 when `max_seq_length` is 192, because the width is `1 + 32 * ceil(length / 32)`. The target row therefore has width 64. Step `s` predicts batch index `s`.

| Step | Token index | Token id | Text | Installed mask | Corrected mask | Padding |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 38 | 38 | 21 | `6` | included | included | no |
| 39 | 39 | 15 | `0` | included | included | no |
| 40 | 40 | 23 | `8` | included | included | no |
| 41 | 41 | 151645 | `<\|im_end\|>` | included | included | no |
| 42 | 42 | 0 | `!` | included | excluded | yes |

Decoded completion span: `608<|im_end|>`. Installed loss-bearing count: 5. Expected loss-bearing count: 4. The installed `default_loss`, called on a stub model with this batch, returned `ntoks = 5`.

The wanted completion steps are `offset` through `tokenCount - 1` inclusive. The installed upper bound also includes step `tokenCount`, which is the first padding cell whenever the padded width is longer than the sequence. On this example that cell is 20% of the normalized loss (1 of 5). Short answer targets make that fraction larger. A 2-token completion would give the pad one third of the loss.

The proposed expression `steps < lengths[:, 1:]` is the correct replacement for `steps <= lengths[:, 1:]` inside the existing conjunction with `steps >= lengths[:, 0:1]`. Used alone, `steps < lengths[:, 1:]` still includes prompt tokens, so it is not a complete mask. The audit records `upperBoundReplacesLessOrEqual: true` and `upperBoundAloneIsComplete: false`.

Two further runtime batches agree with that rule.

- Mixed lengths. A 12-token row and a 47-token row in one batch: installed counts 5 and 10, corrected counts 4 and 9. The real `default_loss` returned `ntoks = 15`, the sum of the two installed counts.
- Sequence filling `max_seq_length`. A 192-token row with offset 190: installed count 2, corrected count 2. Step `192` is outside the target row, so the extra padding target is not created. Historical rows are about 42 tokens against a maximum of 192, so the bug is active for those rows.

The full arrays, token ids, and `ntoks` values are in `mask-audit.json`.

## 5. Corrected-mask tests

The corrected mask lives in `research/m75c/mask.ts` and `research/m75c/corrected_loss.py`. The training worker does not import it. Tests cover the historical width, a sequence that fills the padded buffer, and a mixed-length batch. `paddedWidth(42, 192)` is greater than 42. The filled-buffer case has no extra installed step. The unit file is `tests/unit/research-m75c.test.ts`.

## 6. Historical response-format statistics

Classes: a trimmed response that is only an optional sign and digits is `bare`. A response with an equality, an arithmetic operator, LaTeX `\times` / `\cdot`, or the phrase “step by step” is `worked`. A response with no integer is `unparseable`. Anything else is `other`. Accuracy in this section is the original last-integer score. Premature termination means `completionTokens` reached the stored maximum of 32. M7.5B sealed files do not store completion-token counts, so their truncation rate is not available. Their character lengths match the base, and none of them are bare integers.

### M7.5 sealed, maximum 32 tokens

| Run | Correct | Worked | Bare | Other | Worked accuracy | Bare accuracy | Mean tokens | Truncated |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 134 | 300 | 0 | 0 | 134/300 | — | 28.6 | 212 |
| self-101-r1 | 27 | 17 | 281 | 2 | 6/17 | 21/281 | 3.3 | 0 |
| supervised-101 | 37 | 12 | 287 | 1 | 6/12 | 31/287 | 3.2 | 1 |
| self-202-r1 | 38 | 10 | 290 | 0 | 8/10 | 30/290 | 3.1 | 0 |
| supervised-202 | 29 | 11 | 288 | 1 | 6/11 | 23/288 | 3.3 | 1 |
| self-303-r1 | 33 | 13 | 287 | 0 | 4/13 | 29/287 | 3.2 | 2 |
| supervised-303 | 54 | 40 | 259 | 1 | 29/40 | 25/259 | 4.5 | 0 |

No response lacked an integer, so the last-integer extractor did not fail on these files. The base’s errors and the adapters’ errors are not the same kind of event. The base was usually still writing a worked solution when the 32-token cap arrived. The adapters had already stopped, usually on a short wrong integer. Within the adapters, the few remaining worked answers are more often correct than the bare answers. That is a correlation inside a small subset. The base’s worked answers are correct 134 times out of 300, so the adapters’ worked subset is also absolutely weak.

### M7.5B sealed, maximum 32 tokens

| Run | Correct | Worked | Bare | Mean characters |
| --- | ---: | ---: | ---: | ---: |
| baseline | 138 | 300 | 0 | 70.8 |
| zero-step | 138 | 300 | 0 | 70.8 |
| structured-s5-n25 | 139 | 300 | 0 | 70.3 |
| structured-s5-n25-seed-202 | 139 | 300 | 0 | 70.5 |
| structured-s5-n25-seed-303 | 139 | 300 | 0 | 70.2 |

The structured adapters kept the base’s worked-solution format. Their one-item difference from 138/300 is not a format collapse. Completion-token counts were not stored for these files.

## 7. Two-prompt evaluation

Both prompts use Qwen3-1.7B-MLX-4bit, the historical adapters after a hash check against the stored training records, greedy decoding (`temperature 0`, `top_p 1`, seed 0), and the closed empty think block. Prompt A is the stored historical user string. Prompt B replaces the instruction with: “Solve the arithmetic expression accurately. You may show intermediate calculations. End your response with `Final answer: <integer>`.” The expression is the historical expression. The extractor is `final-answer-then-last-integer-v1`: a `Final answer:` integer if present, otherwise the last integer. It is applied to both prompts. On Prompt A the label is absent, so the extractor reduces to the last integer. Format compliance means a bare integer on Prompt A and a `Final answer:` label on Prompt B.

The comparison set is the M7.5 sealed 300. It is labeled **DIAGNOSTIC**. It was already scored in M7.5, so it is not a pristine holdout. The development set is the 48-item M7.5 `baseline-dev` file, also **DIAGNOSTIC**, because that split was used while M7.5 was running. The 64-item M7.5B development set was used to choose `structured-s5-n25` and is not the comparison set. M7.5B adapters are scored on the M7.5 sealed items so the pairing with the base is exact. That is a transfer comparison, also diagnostic. Their own holdout is used only for the byte-for-byte rerun.

The shared comparison budget is 128 tokens. The byte-for-byte rerun uses the historical budget of 32. Those two budgets answer different questions.

### Reproducibility at 32 tokens

Every rerun matched the stored response on all 300 items.

| Model | Source file | Exact matches |
| --- | --- | --- |
| base | M7.5 baseline-sealed | 300/300 |
| six M7.5 adapters | the matching M7.5 sealed file | 300/300 each |
| three M7.5B adapters | the matching M7.5B sealed file | 300/300 each |

The setup that produced the historical strings is unchanged. Prompt B results below are from that same setup. At 128 tokens, every M7.5 Prompt A response is the stored 32-token response or a continuation of it (300/300 prefix matches). Exact equality holds for the adapters that had already stopped inside 32 tokens. `supervised-101` continues 1 response and scores 38 rather than 37. `self-303-r1` continues 2 responses and scores 35 rather than 33. Those continuations are the only Prompt A score changes. The base continues 212 responses and scores 291 rather than 134.

### Sealed 300, maximum 128 tokens

| Model | Prompt A | Prompt B | Worked A | Bare A | Worked B | Bare B | Label on B | Mean tokens A | Mean tokens B | Truncated A | Truncated B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| base | 291 | 258 | 300 | 0 | 300 | 0 | 193 | 45.0 | 80.8 | 0 | 46 |
| self-101-r1 | 27 | 173 | 17 | 281 | 218 | 0 | 189 | 4.3 | 73.6 | 0 | 75 |
| supervised-101 | 38 | 93 | 12 | 287 | 212 | 86 | 68 | 4.2 | 24.9 | 0 | 0 |
| self-202-r1 | 38 | 222 | 10 | 290 | 265 | 35 | 140 | 4.1 | 58.6 | 0 | 33 |
| supervised-202 | 29 | 143 | 11 | 288 | 259 | 39 | 192 | 4.3 | 51.5 | 0 | 16 |
| self-303-r1 | 35 | 127 | 13 | 287 | 211 | 76 | 129 | 4.2 | 36.2 | 0 | 16 |
| supervised-303 | 54 | 254 | 40 | 259 | 264 | 35 | 247 | 5.5 | 46.0 | 0 | 1 |
| structured-s5-n25 | 290 | 254 | 300 | 0 | 300 | 0 | 191 | 44.7 | 80.6 | 0 | 49 |
| structured-s5-n25-seed-202 | 290 | 253 | 300 | 0 | 300 | 0 | 182 | 44.7 | 80.9 | 0 | 51 |
| structured-s5-n25-seed-303 | 290 | 257 | 300 | 0 | 300 | 0 | 185 | 44.4 | 80.6 | 0 | 47 |

Extraction failures, meaning no safe integer could be read: Prompt A has none. Prompt B has 43 for `self-101-r1`, 14 for `self-303-r1`, and 1 for `supervised-303`. The `self-101-r1` failures include truncated runs of the digit `1`, which the extractor rejects because they are not safe integers. The other models have no extraction failures.

The base’s Prompt B drop is mostly the cap. Of the 39 items the base got right on Prompt A and wrong on Prompt B, 37 are truncated Prompt B outputs. Forty-six Prompt B base outputs hit 128 tokens, and 39 of those 46 are wrong. The 128-token budget was fixed before the run. It was not raised after seeing these rates.

### Development 48, maximum 128 tokens, diagnostic

| Model | Prompt A | Prompt B |
| --- | ---: | ---: |
| base | 46/48 | 42/48 |
| self-101-r1 | 4/48 | 33/48 |
| supervised-101 | 8/48 | 16/48 |
| self-202-r1 | 3/48 | 36/48 |
| supervised-202 | 5/48 | 20/48 |
| self-303-r1 | 5/48 | 20/48 |
| supervised-303 | 10/48 | 42/48 |
| structured-s5-n25 | 46/48 | 41/48 |
| structured-s5-n25-seed-202 | 46/48 | 41/48 |
| structured-s5-n25-seed-303 | 46/48 | 41/48 |

The 48-item set moves in the same direction as the 300-item set and is too small to carry the recovery estimate. The 300-item table is the one to use.

## 8. Paired correctness flips

Counts are items, on the sealed 300, at 128 tokens. “A only” means correct on Prompt A and wrong on Prompt B. “Versus base” compares the adapter with the base under the same prompt: “base only” means the base is correct and the adapter is wrong.

| Model | Both prompts correct | A only | B only | Responses changed | Base only, Prompt A | Adapter only, Prompt A | Base only, Prompt B | Adapter only, Prompt B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| base | 252 | 39 | 6 | 300 | 0 | 0 | 0 | 0 |
| self-101-r1 | 15 | 12 | 158 | 300 | 264 | 0 | 100 | 15 |
| supervised-101 | 9 | 29 | 84 | 281 | 254 | 1 | 178 | 13 |
| self-202-r1 | 29 | 9 | 193 | 296 | 253 | 0 | 61 | 25 |
| supervised-202 | 12 | 17 | 131 | 291 | 263 | 1 | 132 | 17 |
| self-303-r1 | 13 | 22 | 114 | 296 | 256 | 0 | 162 | 31 |
| supervised-303 | 45 | 9 | 209 | 295 | 239 | 2 | 40 | 36 |
| structured-s5-n25 | 247 | 43 | 7 | 300 | 1 | 0 | 4 | 0 |
| structured-s5-n25-seed-202 | 246 | 44 | 7 | 300 | 1 | 0 | 5 | 0 |
| structured-s5-n25-seed-303 | 250 | 40 | 7 | 300 | 1 | 0 | 4 | 3 |

Same-budget recovery is Prompt B minus Prompt A, divided by 300. The fraction is that gain divided by the gap between the adapter’s Prompt A score and the base’s Prompt B score. A second fraction uses the base’s Prompt A score, 291, as the reference. Every M7.5 adapter remains below the base on Prompt B, and below the base on Prompt A.

| Model | Gain, items | Gain, points | Fraction of the gap to base Prompt B | Fraction of the gap to base Prompt A | Below base on Prompt B |
| --- | ---: | ---: | ---: | ---: | --- |
| self-101-r1 | +146 | +48.7 pp | 0.632 | 0.553 | yes, 173 < 258 |
| supervised-101 | +55 | +18.3 pp | 0.250 | 0.217 | yes, 93 < 258 |
| self-202-r1 | +184 | +61.3 pp | 0.836 | 0.727 | yes, 222 < 258 |
| supervised-202 | +114 | +38.0 pp | 0.498 | 0.435 | yes, 143 < 258 |
| self-303-r1 | +92 | +30.7 pp | 0.413 | 0.359 | yes, 127 < 258 |
| supervised-303 | +200 | +66.7 pp | 0.980 | 0.844 | yes, 254 < 258 |

Using the historical base of 134 as the denominator pushes some of these fractions above 1, because 134 is the truncated measurement and 173 already exceeds it. That ratio is not a recovery rate. The M7.5B rows have no material Prompt A deficit against the base (290 versus 291), and Prompt B moves them down with the base. A recovery fraction is not defined for a model that was not behind.

## 9. Twenty-example inspection

The primary sample is 20 item ids drawn from the sealed 300. Ids were sorted, then shuffled with mulberry32, seed **7501**, and the first 20 were kept. The adapter was fixed before Prompt B as `self-101-r1`, the adapter with the largest stored drop (27/300). In this sample the base is correct on 19/20 under Prompt A and 20/20 under Prompt B. The adapter is correct on 1/20 under Prompt A and 11/20 under Prompt B. The sample contains both outcomes.

Prompt B changes `self-101-r1`’s correctness on 170 of 300 items (158 gains, 12 losses). A second sample of 20 was drawn from those 170 with the same seed. That sample is 19 gains and 1 loss. It describes the flip cases. It is not an accuracy estimate.

One primary item, `221f70313a2f18f19a34646417a4583d385e2a6dd6ac02d038eb3998a62bd19d`, ground truth 56:

- Base, Prompt A, correct, worked: `11 + 27 + 18 = 56` followed by the integer result 56.
- Base, Prompt B, correct, worked: `11 + 27 = 38`, then `38 + 18 = 56`, then `Final answer: 56`.
- Adapter, Prompt A, incorrect, bare: `36`.
- Adapter, Prompt B, correct, worked: `11 + 27 = 38`, then `38 + 18 = 56`, then `Final answer: 56`.

The full text of all 40 items, with extracted answers, correctness, and classes, follows in the appendix of this file and in `qualitative.json`.

## 10. Intermediate-validator audit

The validator splits a response into equality lines, strips `$`, backticks, and bold markers, accepts `\times` and a leading minus, and evaluates each piece with the M7.5 arithmetic parser. A chain whose pieces disagree is internally wrong. The last fully readable chain is the claimed value. An earlier correct step is allowed to differ from the final answer. Lines the parser cannot read do not, by themselves, turn a response into an incorrect-arithmetic verdict.

On base Prompt A, 203/300 responses are correct and parseable, 6 are internally wrong or claim the wrong integer, 86 have equalities the parser cannot read, and 5 are mixed. On base Prompt B the corresponding counts are 201, 37, 40, and 22. The large unparseable share is a parser limit: numbered prose on the same line as the equation (`1. Multiply: $10 \times 24 = 240$`), parentheses, and continuation lines that contain only `= 18 - 29`.

There are 1,075 final-answer-correct responses, across the ten models and both prompts on both sets, that the validator does not accept as correct-parseable and that are not simply missing an equality. Twenty were drawn by the same mulberry32 seed from the composite key `model|condition|itemId`. Eighteen are unparseable and two are ambiguous. In every one of the twenty, the visible arithmetic agrees with the extracted answer. The rejections are unread lines, not contradicted arithmetic. Examples include `20 × 21 = 420` then `420 × 9 = 3780`, and `12 - 29 + 6 = (12 + 6) - 29 = 18 - 29 = -11`. The parentheses and the words on the equation line stop the parser. This audit did not rewrite any historical training file.

## 11. Hypothesis assessment

### H1 — Response-format displacement

Evidence for it. The M7.5 adapters replaced worked solutions with bare integers, and their accuracy fell to 27–54/300. Giving the same weights a prompt that permits working moves them back toward worked solutions and raises the extracted-answer accuracy by 55 to 200 items. The adapter that keeps the most bare answers under that prompt, `supervised-101` with 86 bare answers, also has the smallest gain. The M7.5B adapters, which never left the worked format, also never left the base’s accuracy once the token cap is high enough to finish a solution.

Evidence against treating format as the whole mechanism. Under the worked-solution prompt the M7.5 adapters remain below the base. Historical worked answers from those adapters were already less accurate than the base. Prompt B also changes the instruction, so the gain is the effect of that whole prompt, not a pure on/off switch for “showing work” inside an otherwise identical string. The base itself is not helped by Prompt B: it already showed work, and the new prompt plus the 128-token cap makes 46 outputs hit the limit.

Unresolved. Whether the answer-only training target caused the format, or the format is only the visible symptom of a broader weight change. A training run that changes the target while holding the loss fixed would be required. Phase 1A did not run it.

### H2 — Loss-mask contamination

Evidence for the mechanical claim. The installed loss counts the padding id on the historical example, on short rows, and on mixed batches. The filled-buffer case shows the extra count disappears exactly when the padding cell falls outside the target row. The pad is a large fraction of a short answer’s loss.

Evidence against treating the pad as the demonstrated cause of the collapse. M7.5B used the same trainer and did not collapse. Its targets are longer, so the pad is a smaller fraction of each loss, but that difference was not isolated. The earlier zero-step adapter matched the base, which puts the change in the optimizer updates rather than in adapter loading. This audit did not vary the mask and retrain.

Unresolved. The independent contribution of the padding target. Further training is required. Phase 1A cannot supply it.

### H3 — Actual arithmetic capability degradation

Evidence for a remaining gap. After the format prompt, every M7.5 adapter is still below the base on the same items: the best is 254 against a base of 258 on that prompt and 291 on the original prompt. Some Prompt B answers are still bare and wrong. Some are truncated digit runs.

Evidence against a total loss of the skill. The same weights, with no further training, answer 173 to 254 items correctly once working is permitted. `supervised-303` is within 4 items of the base’s truncated Prompt B score and 37 items below the base’s untruncated Prompt A score. The stored 27/300 was the behavior under the bare-integer policy, not a ceiling on these weights.

Unresolved. How much of the remaining gap is the 128-token cap, the new instruction, and a real change in the arithmetic computation. A higher cap would be a new measurement. It was not run.

### H4 — Mixed mechanism

The observations fit a mixture: M7.5 training displaced the response format and the correctness moved with that format, while a confirmed loss-mask defect remains an unmeasured contributor. M7.5B shows that the same loss implementation does not force a collapse for every target. Phase 1A does not separate the shares. Separating them requires a later controlled training experiment. This report does not assign one.

## 12. Remaining uncertainties

- The padding target’s effect on the parameter update is unmeasured.
- Prompt B changes wording, length, and truncation together. The correctness gain is real. The share that belongs only to “showing intermediate calculations” is not isolated from the rest of the instruction.
- Base Prompt B is censored by the 128-token cap. A higher cap could raise 258/300. The adapters would then be compared with a higher base.
- The development set has 48 items and had already been used. The sealed set had already been scored. Both are diagnostic.
- The working validator still misses equations that share a line with prose, equations with parentheses, and lines that are only a continuation after `=`. Its incorrect-arithmetic counts are not a census of bad arithmetic.
- M7.5B sealed files do not store completion-token counts, so their historical truncation rate is unknown. Character length and format show they were worked solutions of about the same size as the base.

## 13. Recommended minimum Phase 1B experiment

Do not treat this section as authorization to run it.

The smallest training experiment that Phase 1A leaves open is a mask comparison, because the format effect is already measured at inference and the mask’s effect is not.

- One factor: the installed loss versus the corrected upper bound `steps < lengths[:, 1:]` combined with the existing offset lower bound.
- Same answer-only data, rank, layers, learning rate, and step count as one stored M7.5 run.
- Select only on a development split that is not the M7.5 sealed 300 and not the M7.5B 64-item selection set.
- Primary score: the original integer prompt, greedy, at a token budget that finishes the base’s worked solutions. Report truncation.
- Secondary score: Prompt B, with the same extractor.
- Freeze the choice, then evaluate a new holdout. No promotion.

A second experiment, answer-only targets versus targets that include working, would test whether the target string is sufficient to suppress working. It should not be crossed with the mask in the first design. Phase 1A does not choose between those questions beyond identifying the mask effect as the one that still requires training.

## 14. Reproduction commands

From the repository root, with the training virtualenv and Node 22:

```bash
services/training/.venv/bin/python research/m75c/mask_runtime.py
services/training/.venv/bin/python research/m75c/generate.py --models all
pnpm exec tsx research/m75c/analyze.ts
pnpm exec vitest run --config vitest.unit.config.ts tests/unit/research-m75c.test.ts
```

`generate.py` appends and skips item ids already present. It checks each adapter’s `adapters.safetensors` hash against the stored training JSON and exits if they differ. It does not write adapters and does not call an optimizer. MLX needs a Metal device. The mask script writes `mask-audit.json`. The analyzer writes the verification, format, reproducibility, two-prompt, qualitative, and validator JSON files, plus `scored/*.jsonl`.

## 15. No new training

Phase 1A did not train. It did not create an adapter. It did not run an optimizer step. It did not modify the operational Qwen3-8B assignment, the historical M7.5 or M7.5B artifacts, or PostgreSQL. It did not integrate a training change into Weight Optimization. It did not start Phase 1B or synthetic skill acquisition. The corrected loss module was tested and was not used to update weights.

## Appendix. Side-by-side responses

The blocks below are copied from `qualitative.json`. Each cell is the raw generation at 128 tokens.

## Primary sample, seed 7501

### 1. `f49edd5fb304cdd81149588cb23c13bb199540da35aa21c14f7300e40c2bdd8e`

Ground truth: `-26`

**Base, Prompt A** — extracted `-26`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

$ 22 - 26 - 22 $

First, compute $ 22 - 26 $:

$ 22 - 26 = -4 $

Then subtract 22:

$ -4 - 22 = -26 $

So the final result is:

$\boxed{-26}$
~~~~

**Base, Prompt B** — extracted `-26`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first subtraction:  
   $ 22 - 26 = -4 $

2. Subtract the next number:  
   $ -4 - 22 = -26 $

Final answer:  
`Final answer: -26`
~~~~

**self-101-r1, Prompt A** — extracted `-16`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
-16
~~~~

**self-101-r1, Prompt B** — extracted `-33`, incorrect, worked, working `missing-working`, truncated `false`

~~~~
1. Start with the first operation: 22 - 26  
-11

2. Next operation: -11 - 22  
-33

Final answer: -33
~~~~

### 2. `1b68a5b1351584471acf9343fe93301ac422c9422ecdeede389706081042e1c7`

Ground truth: `7200`

**Base, Prompt A** — extracted `7200`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

15 × 30 = 450  
450 × 16 = 7200

The integer result is **7200**.
~~~~

**Base, Prompt B** — extracted `7200`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply 15 and 30:  
   $ 15 \times 30 = 450 $

2. Multiply the result by 16:  
   $ 450 \times 16 = 7200 $

Final answer: `7200`
~~~~

**self-101-r1, Prompt A** — extracted `2400`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
2400
~~~~

**self-101-r1, Prompt B** — extracted `7200`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, calculate $15 \times 30$:
   $$
   15 \times 30 = 450
   $$

2. Next, multiply the result by 16:
   $$
   450 \times 16 = 7200
   $$

Final answer: `7200`
~~~~

### 3. `221f70313a2f18f19a34646417a4583d385e2a6dd6ac02d038eb3998a62bd19d`

Ground truth: `56`

**Base, Prompt A** — extracted `56`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
11 + 27 + 18 = 56

The integer result is **56**.
~~~~

**Base, Prompt B** — extracted `56`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Add 11 and 27:  
   $ 11 + 27 = 38 $

2. Add the result to 18:  
   $ 38 + 18 = 56 $

Final answer:  
`Final answer: 56`
~~~~

**self-101-r1, Prompt A** — extracted `36`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
36
~~~~

**self-101-r1, Prompt B** — extracted `56`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
11 + 27 = 38  
38 + 18 = 56  

Final answer: 56
~~~~

### 4. `52d6e333bc7e8b822784f5375e6822143d4eab6ba3023de086d270ebd277eb18`

Ground truth: `608`

**Base, Prompt A** — extracted `608`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

$ 8 \times 19 = 152 $

$ 152 \times 4 = 608 $

**Integer result: 608**
~~~~

**Base, Prompt B** — extracted `608`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
We are given the expression:  
**8 * 19 * 4**

We will compute it step by step.

1. First, compute $ 8 \times 19 $:  
   $$
   8 \times 19 = 152
   $$

2. Next, multiply the result by 4:  
   $$
   152 \times 4 = 608
   $$

Final answer:  
**608**
~~~~

**self-101-r1, Prompt A** — extracted `272`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
272
~~~~

**self-101-r1, Prompt B** — extracted `608`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, calculate $ 8 \times 19 $:  
   $ 8 \times 19 = 152 $

2. Next, multiply the result by 4:  
   $ 152 \times 4 = 608 $

Final answer: 608
~~~~

### 5. `fa22d6f6a421f6315699adb0a327846e06f207f687090d0d56f3b59c75829055`

Ground truth: `37`

**Base, Prompt A** — extracted `37`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
2 + 12 + 23 = 37

Integer result: 37
~~~~

**Base, Prompt B** — extracted `37`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first term:  
   $ 2 $

2. Add the second term:  
   $ 2 + 12 = 14 $

3. Add the third term:  
   $ 14 + 23 = 37 $

Final answer:  
`Final answer: 37`
~~~~

**self-101-r1, Prompt A** — extracted `25`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
25
~~~~

**self-101-r1, Prompt B** — extracted `None`, incorrect, other, working `missing-working`, truncated `true`

~~~~
1.111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111
~~~~

### 6. `06b8c9bfe581b7f91962c10c8dcd47bd26870d2279c1298d566e5928af4c4396`

Ground truth: `96`

**Base, Prompt A** — extracted `96`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

14 * 7 = 98  
98 - 2 = 96

The integer result is: **96**
~~~~

**Base, Prompt B** — extracted `96`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
First, multiply 14 by 7:

$$
14 \times 7 = 98
$$

Next, subtract 2 from the result:

$$
98 - 2 = 96
$$

Final answer:  
`Final answer: 96`
~~~~

**self-101-r1, Prompt A** — extracted `26`, incorrect, worked, working `incorrect-arithmetic`, truncated `false`

~~~~
28-2=26
~~~~

**self-101-r1, Prompt B** — extracted `96`, correct, worked, working `ambiguous`, truncated `false`

~~~~
1. First, perform the multiplication:  
300.11111111111111 (but since we are dealing with integers, it's 14 * 7 = 98)

2. Then, subtract 2:  
98 - 2 = 96

Final answer: 96
~~~~

### 7. `8b462eacea8eb433a9361ead2596be434c217b01075d6159bcefb3ffd1782a89`

Ground truth: `-143`

**Base, Prompt A** — extracted `-143`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's compute the expression step by step:

1. Multiply: $8 \times 21 = 168$
2. Subtract: $25 - 168 = -143$

The integer result is:  
$\boxed{-143}$
~~~~

**Base, Prompt B** — extracted `-143`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
We are given the arithmetic expression:  
**25 - 8 * 21**

We follow the order of operations (PEMDAS/BODMAS):

1. **Multiplication first**:  
   $ 8 * 21 = 168 $

2. **Subtraction next**:  
   $ 25 - 168 = -143 $

Final answer:  
`Final answer: -143`
~~~~

**self-101-r1, Prompt A** — extracted `117`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
117
~~~~

**self-101-r1, Prompt B** — extracted `1111111111111112`, incorrect, other, working `missing-working`, truncated `false`

~~~~
1.1111111111111112
~~~~

### 8. `6e0107a28c35de130bd41a2ba121a4c7213e69732ede3754782712df932dd2d6`

Ground truth: `96`

**Base, Prompt A** — extracted `96`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's compute the expression step by step:

1. Multiply: $4 \times 25 = 100$
2. Subtract: $100 - 4 = 96$

Final result: $\boxed{96}$
~~~~

**Base, Prompt B** — extracted `96`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply: $ 4 \times 25 = 100 $
2. Subtract: $ 100 - 4 = 96 $

Final answer: `96`
~~~~

**self-101-r1, Prompt A** — extracted `200`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
200
~~~~

**self-101-r1, Prompt B** — extracted `96`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, perform the multiplication:  
   $ 4 \times 25 = 100 $

2. Then, subtract 4 from the result:  
   $ 100 - 4 = 96 $

Final answer: `96`
~~~~

### 9. `ce0e04c3d3bcd72909268784d60668d5a5f65a8168278695c4f5491ca1752566`

Ground truth: `161`

**Base, Prompt A** — extracted `161`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
First, compute $ 8 \times 22 $:

$$
8 \times 22 = 176
$$

Then subtract 15:

$$
176 - 15 = 161
$$

The integer result is:

$$
\boxed{161}
$$
~~~~

**Base, Prompt B** — extracted `161`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply: $ 8 \times 22 $
   $$
   8 \times 22 = 176
   $$

2. Subtract: $ 176 - 15 $
   $$
   176 - 15 = 161
   $$

Final answer:  
`Final answer: 161`
~~~~

**self-101-r1, Prompt A** — extracted `200`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
200
~~~~

**self-101-r1, Prompt B** — extracted `2185`, incorrect, worked, working `ambiguous`, truncated `false`

~~~~
1. First, perform the multiplication:  
321 (100) * 22 = 2200  
2. Then, subtract 15:  
2200 - 15 = 2185

Final answer: 2185
~~~~

### 10. `7554e573d9e0e3717af5f5ee64a5cd3f9c55ffa91aa93d19b525188ce87735c1`

Ground truth: `-3`

**Base, Prompt A** — extracted `-3`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
16 - 8 - 11 = 16 - 19 = -3

Integer result: -3
~~~~

**Base, Prompt B** — extracted `-3`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 16 - 8 = 8 $

2. Subtract the next number:  
   $ 8 - 11 = -3 $

Final answer:  
`Final answer: -3`
~~~~

**self-101-r1, Prompt A** — extracted `10`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
10
~~~~

**self-101-r1, Prompt B** — extracted `-3`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 16 - 8  
2. 16 - 8 = 8  
3. Next operation: 8 - 11  
4. 8 - 11 = -3  

Final answer: -3
~~~~

### 11. `76842d946b7ab9c3d47a4aaa8cd243545160b507d3f7bb6b54b934946e70bb67`

Ground truth: `125`

**Base, Prompt A** — extracted `125`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
20 * 6 + 5 = 120 + 5 = 125

Integer result: 125
~~~~

**Base, Prompt B** — extracted `125`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply: $ 20 \times 6 = 120 $
2. Add: $ 120 + 5 = 125 $

Final answer: `125`
~~~~

**self-101-r1, Prompt A** — extracted `155`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
155
~~~~

**self-101-r1, Prompt B** — extracted `305`, incorrect, worked, working `ambiguous`, truncated `false`

~~~~
1. First, perform the multiplication:  
300 (since 20 × 6 = 120)  
2. Then, add 5:  
300 + 5 = 305

Final answer: 305
~~~~

### 12. `4238272a5bf00b8334d0c90562cfa05655c35a371901ed167aeff1c726f52019`

Ground truth: `-8`

**Base, Prompt A** — extracted `-8`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

28 - 27 = 1  
1 - 9 = -8

The integer result is: **-8**.
~~~~

**Base, Prompt B** — extracted `-8`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first subtraction:  
   $ 28 - 27 = 1 $

2. Subtract the next number:  
   $ 1 - 9 = -8 $

Final answer:  
`Final answer: -8`
~~~~

**self-101-r1, Prompt A** — extracted `10`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
10
~~~~

**self-101-r1, Prompt B** — extracted `-8`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 28 - 27  
2. 28 - 27 = 1  
3. Next operation: 1 - 9  
4. 1 - 9 = -8  

Final answer: -8
~~~~

### 13. `6724b287ae3a600e5f2772b697dfdf72f06320d2cf50a7a256193b274bfa8716`

Ground truth: `3150`

**Base, Prompt A** — extracted `3150`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

$ 21 \times 5 = 105 $

$ 105 \times 30 = 3150 $

**Integer result: 3150**
~~~~

**Base, Prompt B** — extracted `3150`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply 21 and 5:  
   $ 21 \times 5 = 105 $

2. Multiply the result by 30:  
   $ 105 \times 30 = 3150 $

Final answer: `3150`
~~~~

**self-101-r1, Prompt A** — extracted `1050`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
1050
~~~~

**self-101-r1, Prompt B** — extracted `3150`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, calculate $ 21 \times 5 $:  
   $ 21 \times 5 = 105 $

2. Next, multiply the result by 30:  
   $ 105 \times 30 = 3150 $

Final answer: `3150`
~~~~

### 14. `0a900dc745b40b4bfd1fa55543bd9509adfca320eba08b4eb0a7e45a067034a2`

Ground truth: `43`

**Base, Prompt A** — extracted `43`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
17 + 30 - 4 = 43

The integer result is 43.
~~~~

**Base, Prompt B** — extracted `43`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 17 + 30 = 47 $

2. Subtract the next number:  
   $ 47 - 4 = 43 $

Final answer:  
`Final answer: 43`
~~~~

**self-101-r1, Prompt A** — extracted `33`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
33
~~~~

**self-101-r1, Prompt B** — extracted `45`, incorrect, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 19  
2. Add 30: 19 + 30 = 49  
3. Subtract 4: 49 - 4 = 45  

Final answer: 45
~~~~

### 15. `ad598c126bd33cdb27a03751b4048ec9ac5be69a9d1d7685caa5c0c975d3fe38`

Ground truth: `19`

**Base, Prompt A** — extracted `29`, incorrect, worked, working `incorrect-arithmetic`, truncated `false`

~~~~
13 + 29 - 23 = 29
~~~~

**Base, Prompt B** — extracted `19`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first two numbers:  
   $ 13 + 29 = 42 $

2. Subtract the next number:  
   $ 42 - 23 = 19 $

Final answer:  
`Final answer: 19`
~~~~

**self-101-r1, Prompt A** — extracted `20`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
20
~~~~

**self-101-r1, Prompt B** — extracted `21`, incorrect, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 15 + 29  
2. Add 15 and 29: 15 + 29 = 44  
3. Subtract 23 from the result: 44 - 23 = 21  

Final answer: 21
~~~~

### 16. `fbd15a7f08b4a848767338e412e2d00085272a63fc491f46bc84dd17b38d73cb`

Ground truth: `-6`

**Base, Prompt A** — extracted `-6`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
12 + 8 - 26 = 12 + 8 = 20; 20 - 26 = -6

Integer result: -6
~~~~

**Base, Prompt B** — extracted `-6`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 12 + 8 = 20 $

2. Next, subtract 26:  
   $ 20 - 26 = -6 $

Final answer: `<integer>-6`
~~~~

**self-101-r1, Prompt A** — extracted `16`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
16
~~~~

**self-101-r1, Prompt B** — extracted `-11`, incorrect, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 15  
2. Next, subtract 26: 15 - 26 = -11  
3. Final result: -11  

Final answer: -11
~~~~

### 17. `4f61c422b69d35ac046715a89a8e3339b4af9f81c1ec058be30e959fcc3bba84`

Ground truth: `422`

**Base, Prompt A** — extracted `422`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

$ 21 \times 19 + 23 $

First, compute $ 21 \times 19 $:

$$
21 \times 19 = 399
$$

Then add 23:

$$
399 + 23 = 422
$$

Final result: $\boxed{422}$
~~~~

**Base, Prompt B** — extracted `422`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
First, calculate $ 21 \times 19 $:

$$
21 \times 19 = 399
$$

Next, add 23 to the result:

$$
399 + 23 = 422
$$

Final answer:  
`Final answer: 422`
~~~~

**self-101-r1, Prompt A** — extracted `422`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
21*19 + 23 = 399 + 23 = 422
~~~~

**self-101-r1, Prompt B** — extracted `422`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, calculate $21 \times 19$:
   $$
   21 \times 19 = 399
   $$

2. Then add 23 to the result:
   $$
   399 + 23 = 422
   $$

Final answer: `422`
~~~~

### 18. `41a8aa419e38671c893d8323cc05344200335354553c7f8540826712e2eb063d`

Ground truth: `-24`

**Base, Prompt A** — extracted `-24`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

14 - 15 = -1  
-1 - 23 = -24

The integer result is:  
**-24**
~~~~

**Base, Prompt B** — extracted `-24`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first subtraction:  
   $ 14 - 15 = -1 $

2. Subtract the next number:  
   $ -1 - 23 = -24 $

Final answer:  
`Final answer: -24`
~~~~

**self-101-r1, Prompt A** — extracted `26`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
26
~~~~

**self-101-r1, Prompt B** — extracted `-24`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 14 - 15  
2. 14 - 15 = -1  
3. Next operation: -1 - 23  
4. -1 - 23 = -24  

Final answer: -24
~~~~

### 19. `a31c5abb2afbbd75aaf3987300a3d2c9eb5a634faae5b131a42e27400fdab25e`

Ground truth: `3`

**Base, Prompt A** — extracted `3`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

27 - 19 = 8  
8 - 5 = 3

The integer result is **3**.
~~~~

**Base, Prompt B** — extracted `3`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first subtraction:  
   $ 27 - 19 = 8 $

2. Subtract the next number:  
   $ 8 - 5 = 3 $

Final answer:  
`Final answer: 3`
~~~~

**self-101-r1, Prompt A** — extracted `10`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
10
~~~~

**self-101-r1, Prompt B** — extracted `3`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first subtraction: 27 - 19 = 8  
2. Subtract the next number: 8 - 5 = 3  

Final answer: 3
~~~~

### 20. `82ab7b61600aaaf0751d6108ea5010d87db00004cca849574900cc4fd0180d22`

Ground truth: `29`

**Base, Prompt A** — extracted `29`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
22 + 22 - 15 = 29

Integer result: 29
~~~~

**Base, Prompt B** — extracted `29`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 22 + 22 = 44 $

2. Next, subtract 15:  
   $ 44 - 15 = 29 $

Final answer:  
`Final answer: 29`
~~~~

**self-101-r1, Prompt A** — extracted `19`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
19
~~~~

**self-101-r1, Prompt B** — extracted `None`, incorrect, other, working `missing-working`, truncated `true`

~~~~
1.111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111
~~~~

## Additional sample from prompt-correctness flips, seed 7501

### 1. `d728914776e45dca1c69c8e64d919bdea7eafa994ca418c8d8ff20359f815bfc`

Ground truth: `181`

**Base, Prompt A** — extracted `181`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's compute the expression step by step:

1. Multiply: $ 11 \times 15 = 165 $
2. Add: $ 165 + 16 = 181 $

Final result: $ \boxed{181} $
~~~~

**Base, Prompt B** — extracted `181`, correct, worked, working `incorrect-arithmetic`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply: $ 11 \times 15 $
   - $ 11 \times 15 = 165 $

2. Add: $ 165 + 16 $

Final answer: $ 165 + 16 = 181 $

Final answer: `<integer>181`
~~~~

**self-101-r1, Prompt A** — extracted `236`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
236
~~~~

**self-101-r1, Prompt B** — extracted `181`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, perform the multiplication:  
   11 * 15 = 165

2. Then, add 16 to the result:  
   165 + 16 = 181

Final answer: 181
~~~~

### 2. `20652faa03d6dc4080baa3c441b3556274e1896081239dc7032ea40271cda36c`

Ground truth: `-17`

**Base, Prompt A** — extracted `-17`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

16 - 12 = 4  
4 - 21 = -17

The integer result is: **-17**.
~~~~

**Base, Prompt B** — extracted `-17`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 16 - 12 = 4 $

2. Subtract the next number:  
   $ 4 - 21 = -17 $

Final answer:  
`Final answer: -17`
~~~~

**self-101-r1, Prompt A** — extracted `15`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
15
~~~~

**self-101-r1, Prompt B** — extracted `-17`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 16 - 12  
2. 16 - 12 = 4  
3. Next operation: 4 - 21  
4. 4 - 21 = -17  

Final answer: -17
~~~~

### 3. `eb4e2fe435b9d4ca665afb87030ad6e19f0d15b6f7e52854c4c14335cc062a2d`

Ground truth: `28`

**Base, Prompt A** — extracted `28`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
26 + 24 - 22 = 28

The integer result is **28**.
~~~~

**Base, Prompt B** — extracted `28`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first two numbers:  
   $ 26 + 24 = 50 $

2. Subtract the next number:  
   $ 50 - 22 = 28 $

Final answer:  
`Final answer: 28`
~~~~

**self-101-r1, Prompt A** — extracted `28`, correct, bare, working `missing-working`, truncated `false`

~~~~
28
~~~~

**self-101-r1, Prompt B** — extracted `None`, incorrect, other, working `missing-working`, truncated `true`

~~~~
1.111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111
~~~~

### 4. `53b09b3c2ba3ec0529c1b0bad4bf27b0572e64a0cac51da59754d160e112d40e`

Ground truth: `34`

**Base, Prompt A** — extracted `34`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

29 - 13 = 16  
16 + 18 = 34

The integer result is **34**.
~~~~

**Base, Prompt B** — extracted `34`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 29 - 13 = 16 $

2. Next, add the result to 18:  
   $ 16 + 18 = 34 $

Final answer:  
`Final answer: 34`
~~~~

**self-101-r1, Prompt A** — extracted `14`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
14
~~~~

**self-101-r1, Prompt B** — extracted `34`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 29 - 13  
2. 29 - 13 = 16  
3. Next operation: 16 + 18  
4. 16 + 18 = 34  

Final answer: 34
~~~~

### 5. `6025c73414ec3a1590a582f88424acd5e8e65d810c972ab8db68ce53e4fc8d08`

Ground truth: `386`

**Base, Prompt A** — extracted `386`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

16 * 23 = 368  
368 + 18 = 386

The integer result is:  
**386**
~~~~

**Base, Prompt B** — extracted `386`, correct, worked, working `incorrect-arithmetic`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply: $ 16 \times 23 $
   - $ 16 \times 20 = 320 $
   - $ 16 \times 3 = 48 $
   - $ 320 + 48 = 368 $

2. Add: $ 368 + 18 $

Final answer: $ 368 + 18 = 386 $

Final answer: `<integer>386`
~~~~

**self-101-r1, Prompt A** — extracted `208`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
208
~~~~

**self-101-r1, Prompt B** — extracted `386`, correct, worked, working `ambiguous`, truncated `false`

~~~~
1. First, perform the multiplication:  
320 (since 16 × 23 = 368, but wait, let's do it step by step)  
- 16 × 20 = 320  
- 16 × 3 = 48  
- 320 + 48 = 368

2. Now add the remaining term:  
368 + 18 = 386

Final answer: 386
~~~~

### 6. `657ef3592fb6c34556f85e9329b25856b5642899e3cb549a7fef55340498b078`

Ground truth: `-486`

**Base, Prompt A** — extracted `-486`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

1. First, perform the multiplication:
   $ 19 \times 27 = 513 $

2. Then subtract from 27:
   $ 27 - 513 = -486 $

The integer result is:

**-486**
~~~~

**Base, Prompt B** — extracted `513`, incorrect, worked, working `incorrect-arithmetic`, truncated `true`

~~~~
We are given the arithmetic expression:

**27 - 19 * 27**

To solve this, we follow the **order of operations** (PEMDAS/BODMAS):

1. **Parentheses** (none here)
2. **Exponents** (none here)
3. **Multiplication and Division** (from left to right)
4. **Addition and Subtraction** (from left to right)

So, we first compute the multiplication:

**19 * 27**

Let's calculate that:

**19 * 27 = 513**

Now substitute back into the original
~~~~

**self-101-r1, Prompt A** — extracted `110`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
110
~~~~

**self-101-r1, Prompt B** — extracted `-486`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, perform the multiplication operation:  
   19 × 27 = 513

2. Then, subtract the result from 27:  
   27 - 513 = -486

Final answer: -486
~~~~

### 7. `00f04df5743a133a4e786160bb8ecf0b0716c873bf8cf36675bb8a7c23919817`

Ground truth: `-23`

**Base, Prompt A** — extracted `-23`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

12 - 15 = -3  
-3 - 20 = -23

The integer result is: **-23**.
~~~~

**Base, Prompt B** — extracted `-23`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 12 - 15 = -3 $

2. Subtract the next number:  
   $ -3 - 20 = -23 $

Final answer:  
`Final answer: -23`
~~~~

**self-101-r1, Prompt A** — extracted `-13`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
-13
~~~~

**self-101-r1, Prompt B** — extracted `-23`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. Start with the first operation: 12 - 15  
-15 is less than 12, so the result is -3.  
-3 is the result of 12 - 15.

2. Next, subtract 20 from the result: -3 - 20  
-3 - 20 = -23

Final answer: -23
~~~~

### 8. `ff4d370cdbfe0f67f14f514f46f7dc09456487daade99a81de1c1af76f88f61e`

Ground truth: `219`

**Base, Prompt A** — extracted `219`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

$ 22 \times 9 = 198 $

Then add 21:

$ 198 + 21 = 219 $

Final result: $ \boxed{219} $
~~~~

**Base, Prompt B** — extracted `219`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply: $ 22 \times 9 $
   $$
   22 \times 9 = 198
   $$

2. Add: $ 198 + 21 $
   $$
   198 + 21 = 219
   $$

Final answer:  
`Final answer: 219`
~~~~

**self-101-r1, Prompt A** — extracted `231`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
231
~~~~

**self-101-r1, Prompt B** — extracted `219`, correct, worked, working `ambiguous`, truncated `false`

~~~~
1. First, perform the multiplication:  
318 (since 22 * 9 = 198)  
2. Then, add 21 to the result:  
198 + 21 = 219

Final answer: 219
~~~~

### 9. `aa694373cf172cba64537bc6af55db7ee3b85a60d157db258700a876e8333f6c`

Ground truth: `12`

**Base, Prompt A** — extracted `12`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's compute the expression step by step:

4 - 12 + 20  
= (4 - 12) + 20  
= (-8) + 20  
= 12

The integer result is: **12**.
~~~~

**Base, Prompt B** — extracted `12`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's solve the expression step by step:

Start with the given expression:  
**4 - 12 + 20**

We perform the operations from left to right:

1. $ 4 - 12 = -8 $
2. $ -8 + 20 = 12 $

Final answer:  
**Final answer: 12**
~~~~

**self-101-r1, Prompt A** — extracted `16`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
16
~~~~

**self-101-r1, Prompt B** — extracted `12`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 4 - 12 = -8  
2. Next, add 20: -8 + 20 = 12  

Final answer: 12
~~~~

### 10. `d9fbe9ee50243a4fa070052549260045fe28186a241fadc708346cc25abd0550`

Ground truth: `-36`

**Base, Prompt A** — extracted `-36`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's compute the expression step by step:

8 - 23 - 21  
= (8 - 23) - 21  
= (-15) - 21  
= -36

The integer result is:  
**-36**
~~~~

**Base, Prompt B** — extracted `-36`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 8 - 23 = -15 $

2. Subtract the next number:  
   $ -15 - 21 = -36 $

Final answer:  
`Final answer: -36`
~~~~

**self-101-r1, Prompt A** — extracted `10`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
10
~~~~

**self-101-r1, Prompt B** — extracted `-36`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 8 - 23  
2. -15 is the result of 8 - 23.  
3. Now subtract 21: -15 - 21 = -36

Final answer: -36
~~~~

### 11. `3923ea1ec88fddf55a4120e9c222428bdbabbb191fc3975bf5aa3026eb2a6ec7`

Ground truth: `18`

**Base, Prompt A** — extracted `18`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
10 + 29 - 21 = 18
~~~~

**Base, Prompt B** — extracted `18`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 10 + 29 = 39 $

2. Next, subtract 21:  
   $ 39 - 21 = 18 $

Final answer:  
`Final answer: 18`
~~~~

**self-101-r1, Prompt A** — extracted `28`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
28
~~~~

**self-101-r1, Prompt B** — extracted `18`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 10 + 29  
2. Add 10 and 29: 39  
3. Subtract 21 from the result: 39 - 21 = 18  

Final answer: 18
~~~~

### 12. `eefed216a5d3b781ab7d9e765ca77693bbcea5d6c788f06841a38a4b545ecc28`

Ground truth: `-8`

**Base, Prompt A** — extracted `-8`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

13 + 2 = 15  
15 - 23 = -8

The integer result is:  
**-8**
~~~~

**Base, Prompt B** — extracted `-8`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first operation:  
   $ 13 + 2 = 15 $

2. Next, subtract 23:  
   $ 15 - 23 = -8 $

Final answer: `-8`
~~~~

**self-101-r1, Prompt A** — extracted `24`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
24
~~~~

**self-101-r1, Prompt B** — extracted `-8`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 15  
2. Next, subtract 23: 15 - 23 = -8  
3. Final result: -8  

Final answer: -8
~~~~

### 13. `d0ab1353182f4d30f5e012b403494216c55bcba574535f7552c415ec27589d37`

Ground truth: `62`

**Base, Prompt A** — extracted `62`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
29 + 13 + 20 = 62  

Integer result: 62
~~~~

**Base, Prompt B** — extracted `62`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Add 29 and 13:  
   $ 29 + 13 = 42 $

2. Add the result to 20:  
   $ 42 + 20 = 62 $

Final answer: `62`
~~~~

**self-101-r1, Prompt A** — extracted `36`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
36
~~~~

**self-101-r1, Prompt B** — extracted `62`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first addition: 29 + 13 = 42  
2. Add the next number: 42 + 20 = 62  

Final answer: 62
~~~~

### 14. `bced3346f3c4bd8f2d3040173654b54ee363a3ca27cc8642e28c5ad222ef69ab`

Ground truth: `-2`

**Base, Prompt A** — extracted `-2`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's compute the expression step by step:

9 - 27 + 16  
= (9 - 27) + 16  
= (-18) + 16  
= -2

The integer result is: **-2**.
~~~~

**Base, Prompt B** — extracted `-2`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first two numbers:  
   $ 9 - 27 = -18 $

2. Add the next number:  
   $ -18 + 16 = -2 $

Final answer: `<integer>-2`
~~~~

**self-101-r1, Prompt A** — extracted `10`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
10
~~~~

**self-101-r1, Prompt B** — extracted `-2`, correct, worked, working `missing-working`, truncated `false`

~~~~
1. Start with the first operation: 9 - 27  
-18

2. Next operation: -18 + 16  
-2

Final answer: -2
~~~~

### 15. `fe23778e32fa392b0722b3736173d6c3efc7cdca5d99605674c10fbbc04a8d37`

Ground truth: `565`

**Base, Prompt A** — extracted `565`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

$ 30 \times 18 = 540 $

Then add 25:

$ 540 + 25 = 565 $

The integer result is:

**565**
~~~~

**Base, Prompt B** — extracted `565`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
First, multiply 30 and 18:

$$
30 \times 18 = 540
$$

Next, add 25 to the result:

$$
540 + 25 = 565
$$

Final answer:  
`Final answer: 565`
~~~~

**self-101-r1, Prompt A** — extracted `270`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
270
~~~~

**self-101-r1, Prompt B** — extracted `565`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, perform the multiplication:  
   30 × 18 = 540

2. Then, add the result to 25:  
   540 + 25 = 565

Final answer: 565
~~~~

### 16. `1b68a5b1351584471acf9343fe93301ac422c9422ecdeede389706081042e1c7`

Ground truth: `7200`

**Base, Prompt A** — extracted `7200`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

15 × 30 = 450  
450 × 16 = 7200

The integer result is **7200**.
~~~~

**Base, Prompt B** — extracted `7200`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply 15 and 30:  
   $ 15 \times 30 = 450 $

2. Multiply the result by 16:  
   $ 450 \times 16 = 7200 $

Final answer: `7200`
~~~~

**self-101-r1, Prompt A** — extracted `2400`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
2400
~~~~

**self-101-r1, Prompt B** — extracted `7200`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, calculate $15 \times 30$:
   $$
   15 \times 30 = 450
   $$

2. Next, multiply the result by 16:
   $$
   450 \times 16 = 7200
   $$

Final answer: `7200`
~~~~

### 17. `cd40f425a33a24bb18dafe4a2f26fbe51c417eeda8c254d1423027057c987eda`

Ground truth: `477`

**Base, Prompt A** — extracted `477`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's compute the expression step by step:

1. Multiply: $30 \times 16 = 480$
2. Subtract: $480 - 3 = 477$

Final result: $\boxed{477}$
~~~~

**Base, Prompt B** — extracted `477`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
First, perform the multiplication:

$$
30 \times 16 = 480
$$

Next, subtract 3 from the result:

$$
480 - 3 = 477
$$

Final answer:  
`Final answer: 477`
~~~~

**self-101-r1, Prompt A** — extracted `240`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
240
~~~~

**self-101-r1, Prompt B** — extracted `477`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, calculate the multiplication:  
   30 × 16 = 480

2. Then, subtract 3 from the result:  
   480 − 3 = 477

Final answer: 477
~~~~

### 18. `de0d10b923dac7407e1de5f028700bb5056da76a9eba8c0055476e6e61f991ba`

Ground truth: `107`

**Base, Prompt A** — extracted `107`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

$ 7 \times 12 = 84 $

Then add 23:

$ 84 + 23 = 107 $

Final result:  
**107**
~~~~

**Base, Prompt B** — extracted `107`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Multiply: $ 7 \times 12 = 84 $
2. Add: $ 84 + 23 = 107 $

Final answer: `107`
~~~~

**self-101-r1, Prompt A** — extracted `250`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
250
~~~~

**self-101-r1, Prompt B** — extracted `107`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
1. First, perform the multiplication:  
   7 * 12 = 84

2. Then, add the result to 23:  
   84 + 23 = 107

Final answer: 107
~~~~

### 19. `3a58070c3dda17375511502e7819be89c6cfe3c092c8ea138cfd385bdd2275cd`

Ground truth: `25`

**Base, Prompt A** — extracted `25`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

15 - 6 = 9  
9 + 16 = 25

The integer result is **25**.
~~~~

**Base, Prompt B** — extracted `25`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first two numbers:  
   $ 15 - 6 = 9 $

2. Now add the result to 16:  
   $ 9 + 16 = 25 $

Final answer:  
`Final answer: 25`
~~~~

**self-101-r1, Prompt A** — extracted `10`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
10
~~~~

**self-101-r1, Prompt B** — extracted `25`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 15 - 6  
2. 15 - 6 = 9  
3. Next operation: 9 + 16  
4. 9 + 16 = 25  

Final answer: 25
~~~~

### 20. `757141394cb8ab926b3ae3f1fc8d077b9db3c25daedf23401f86bc500cca50b5`

Ground truth: `27`

**Base, Prompt A** — extracted `27`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's compute the expression step by step:

23 - 13 = 10  
10 + 17 = 27

The integer result is **27**.
~~~~

**Base, Prompt B** — extracted `27`, correct, worked, working `correct-parseable`, truncated `false`

~~~~
Let's solve the expression step by step:

1. Start with the first two numbers:  
   $ 23 - 13 = 10 $

2. Add the result to the next number:  
   $ 10 + 17 = 27 $

Final answer:  
`Final answer: 27`
~~~~

**self-101-r1, Prompt A** — extracted `17`, incorrect, bare, working `missing-working`, truncated `false`

~~~~
17
~~~~

**self-101-r1, Prompt B** — extracted `27`, correct, worked, working `unparseable-working`, truncated `false`

~~~~
1. Start with the first operation: 23 - 13  
2. 23 - 13 = 10  
3. Next operation: 10 + 17  
4. 10 + 17 = 27  

Final answer: 27
~~~~

