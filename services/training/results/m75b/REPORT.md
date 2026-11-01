# M7.5B training stability report

M8 was not started. No adapter was promoted or assigned. Operational Qwen3-8B stayed `not_deployed` with a null artifact. The PostgreSQL instance on port 5434 was not migrated; `training_experiments` is absent there. Canonical PostgreSQL `127.0.0.1:5433` received only the additive `0008_training_experiments` migration.

Status: **ENGINEERING_PASS / SCIENTIFIC_FAIL**.

A lower training loss is not an improvement. The configuration selected on development data gained one item on a fresh 300-item holdout. Exact McNemar p-values are 1. That is not a verified improvement, and Weight Optimization did not deploy it.

## 1. Historical M7.5 evidence

`research/m75/score.ts` recomputed the sealed JSONL files before any new training. The counts matched the stored result. There was no discrepancy, and `services/training/results/m75/` was not overwritten.

| Run | Recomputed |
| --- | ---: |
| Untouched Qwen3-1.7B | 134/300 |
| self-101 | 27/300 |
| supervised-101 | 37/300 |
| self-202 | 38/300 |
| supervised-202 | 29/300 |
| self-303 | 33/300 |
| supervised-303 | 54/300 |

Those runs used three seeds, both self-verified and programmatic targets, about 22–28 examples, 80 optimizer steps, and learning rate 0.0001. The recomputed file is `historical-verification.json`.

## 2. Model and checkpoint

Primary checkpoint `Qwen/Qwen3-1.7B-MLX-4bit`, revision `21457c6f51ed54a7c16e988c0844db973815c137`. Qwen3, 28 layers, 4-bit, group size 128. The worker's base-weight identity is `4d461171f280e0e4c925764d9805d83b9cd0930a7d2b237213ae7ae3fda23dcd`, unchanged from the M7.5 probe. The raw `model.safetensors` SHA-256 is `42e688d626b3e144bf721af7517a82f3ea7e97bb5764fef1c89942bf9165072a`. Every training result records `baseUnchanged: true` against the worker identity. The 0.6B fallback was not used. LoRA rank 8, scale 2, dropout 0, last 8 layers, projections `q_proj` and `v_proj`, 458,752 trainable parameters.

## 3. Training and inference parity

The audit rendered this prompt for both training and greedy evaluation:

```text
<|im_start|>user
Compute the value of the expression. Reply with the integer result only.
Expression: 19 * 16 * 2<|im_end|>
<|im_start|>assistant
<think>

</think>

```

The training prefix and the inference prefix are the same token sequence (38 tokens). Evaluation used temperature 0, top-p 1, 32 tokens, and the same closed empty think prefix. A second base evaluation of the 64-item development set changed 0 responses.

## 4. Token-masking audit

For `19 * 16 * 2`, whose verified value is 608, the loss span is the answer plus the end-of-sequence token. Prompt tokens, including the think prefix, are masked. Padding is not added to these short examples.

```text
608<|im_end|>
```

Token ids: `21, 15, 23, 151645`. The word `Expression` is absent from the loss span. The structured target for the same item trains on the verified equations only:

```text
19 * 16 = 304
304 * 2 = 608<|im_end|>
```

That span is 24 tokens. Each equation recomputes, and the final integer is the programmatic answer. The worker rejects a structured line that does not recompute.

## 5. Zero-step control

An initialized LoRA adapter was saved with no optimizer step. Its L2 norm is 6.530. On the fresh development set it changed 0 of 64 responses, and accuracy stayed 32/64. Disabling the adapter restored the base responses exactly. On the fresh sealed holdout the base and the zero-step adapter both score 138/300. Loading an initialized adapter does not explain the M7.5 regression. Optimization was started only after this control passed.

## 6. Experiment configurations

Fresh development set: cell `asm3-30`, seed `21004`, 64 items, disjoint from every M7.5 canonical expression and template. Fresh sealed holdout: seed `21005`, 300 items, generated only after `frozen-config.json` was written. Training pools were 25, 250, and 1,000 programmatic examples, also disjoint. Batch size is 1, so mean exposure is `steps / dataset size`.

Development accuracy is the selection metric. A run is severe when development accuracy falls more than 0.15 below the base, and that learning rate is not trained for a longer step count. The 0.0001 learning rate was stopped after 10 steps. The 0.00003 learning rate was stopped after 40 steps. The 0.00001 learning rate stayed inside the tolerance through 40 steps.

| Run | Steps | Learning rate | Examples | Exposure | Target | Development | Severe |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| lr1e-5-s5-n25 | 5 | 1e-5 | 25 | 0.200 | answer | 32/64 | no |
| lr3e-5-s5-n25 | 5 | 3e-5 | 25 | 0.200 | answer | 32/64 | no |
| lr1e-4-s5-n25 | 5 | 1e-4 | 25 | 0.200 | answer | 25/64 | no |
| lr1e-5-s10-n25 | 10 | 1e-5 | 25 | 0.400 | answer | 32/64 | no |
| lr1e-5-s20-n25 | 20 | 1e-5 | 25 | 0.800 | answer | 30/64 | no |
| lr1e-5-s40-n25 | 40 | 1e-5 | 25 | 1.600 | answer | 32/64 | no |
| lr3e-5-s10-n25 | 10 | 3e-5 | 25 | 0.400 | answer | 28/64 | no |
| lr3e-5-s20-n25 | 20 | 3e-5 | 25 | 0.800 | answer | 23/64 | no |
| lr3e-5-s40-n25 | 40 | 3e-5 | 25 | 1.600 | answer | 5/64 | yes |
| lr1e-4-s10-n25 | 10 | 1e-4 | 25 | 0.400 | answer | 19/64 | yes |
| lr1e-5-s5-n250 | 5 | 1e-5 | 250 | 0.020 | answer | 32/64 | no |
| lr1e-5-s5-n1000 | 5 | 1e-5 | 1,000 | 0.005 | answer | 32/64 | no |
| lr1e-5-s50-n250-exposure | 50 | 1e-5 | 250 | 0.200 | answer | 27/64 | no |
| structured-s5-n25 | 5 | 1e-5 | 25 | 0.200 | structured | 33/64 | no |
| structured-s5-n250 | 5 | 1e-5 | 250 | 0.020 | structured | 33/64 | no |

Format accuracy stayed 32/32 on the development arithmetic items for every run. The short retention check stayed 32/32. Peak training memory was 1,247,210,336 bytes. Training durations were 1.5–4.7 seconds. Full per-run hashes, norms, and curves are in `training/*.json`.

## 7. Learning curves

`lr3e-5-s40-n25` is the diagnostic collapse. Training loss moved from 9.10 at step 1 to 0.56 at step 40. Validation loss moved from 12.49 to 1.28. Development accuracy moved from 32/64 to 5/64. The adapter L2 moved from 6.530 at initialization to 6.936. Falling loss accompanied a large accuracy loss.

`lr1e-4-s10-n25` was already down to 19/64 by step 10, with training loss 2.32 and validation loss 2.65. Longer training at that learning rate was not run.

`lr1e-5-s40-n25` also reduced loss, from 9.10 to 3.58 on train and from 12.49 to 3.73 on validation, while development accuracy stayed 32/64. A lower loss with unchanged accuracy is not a successful calculator.

## 8. Dataset-size comparison

At 5 steps and learning rate 1e-5, 25, 250, and 1,000 examples all score 32/64. Those runs do not have the same exposure: mean exposures are 0.200, 0.020, and 0.005. The matched-exposure comparison is 50 steps on 250 examples, which has the same 0.200 exposure as 5 steps on 25 examples. That run scores 27/64. The larger set is not better once exposure is matched, so this milestone does not claim a dataset-size benefit.

## 9. Training-target comparison

Answer-only and structured-solution training used the same 25 items, the same learning rate, and the same 5 steps. Development scores were 32/64 and 33/64. The same one-item difference appears for the 250-example structured run. Structured targets are programmatically checked equations, not model-generated reasoning. They did not produce a development separation large enough to prefer them on accuracy alone. The selector still froze the structured 25-example run because it was the highest development score and was within 0.02 of the base.

## 10. Development selection

The base development score is 32/64. `structured-s5-n25` scored 33/64 and was written to `frozen-config.json` with `selectedBeforeSealed: true` before the sealed split existed. The rule treated it as promising because it was at least base minus 0.02, so seeds 202 and 303 were trained from the same untouched base. No later configuration was chosen after the holdout.

## 11. Fresh sealed evaluation

Seed `21005`, 300 items, cell `asm3-30`, disjoint from the M7.5 holdout and from the new training and development pools. Independent rescoring:

| Candidate | Correct | Paired difference | Baseline-only | Candidate-only | Exact McNemar p | Conclusion |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Base | 138/300 | — | — | — | — | — |
| Zero-step adapter | 138/300 | 0 | — | — | — | control |
| structured-s5-n25, seed 101 | 139/300 | +0.0033 | 1 | 2 | 1 | INCONCLUSIVE |
| structured-s5-n25, seed 202 | 139/300 | +0.0033 | 0 | 1 | 1 | INCONCLUSIVE |
| structured-s5-n25, seed 303 | 139/300 | +0.0033 | 1 | 2 | 1 | INCONCLUSIVE |

All three seeds are reported. Deployment eligibility is false for every comparison. The old 300-item holdout was not reused.

## 12. Retention

The unrelated record-extraction and exact-copy check is 32 items. The base, the zero-step adapter, and all three sealed seeds score 32/32. Development retention was also 32/32 for every trained run, including the run that fell to 5/64 on arithmetic. This check can miss damage outside extraction and copying.

## 13. Statistical analysis

The pre-registered research conclusion requires a positive paired difference, an exact McNemar p-value below 0.05, a sample of at least 100, and intact retention. Each seed's p-value is 1. The one-item gain is inside ordinary binomial noise around 138/300. Wilson intervals for 138/300 and 139/300 overlap almost completely. No seed is a verified improvement, and the three seeds do not become one by averaging.

## 14. Seeds

Seeds 101, 202, and 303 each started from the untouched base and trained the frozen structured configuration. Sealed accuracies are 139, 139, and 139 out of 300. Their discordant pairs are not the same items, so they are independent trainings that happen to share the same count. The best seed was not selected after the fact.

## 15. Time and memory

Each short LoRA run used about 1.25 GB peak and finished in a few seconds. The zero-step initialization used about 0.92 GB and 769 ms. The expensive part was repeated 1.7B evaluation, not the optimizer. No Qwen3-8B inference was run beside these jobs.

## 16. Adapter hashes

Zero-step: `ece860814833cc738f4576cb9e522d067662348bfe6ce8134068ca0b1df096ab`.

The selected seed-101 adapter is `2068e8cd2f4ea3d143a4517af192806d9becb9ec7b18d4f45158e5de69a8756d`. The other run hashes are in section 6's source file `development.json` and in `training/*.json`. Weights remain under `services/training/research-artifacts/m75b/` and are not the operational model.

## 17. Training method registry

Implemented and executable on Qwen3 through MLX-LM: `lora-supervised` `m75b-v1`, `verified-rejection-sft` `m75b-v1`, and `structured-solution-sft` `m75b-v1`. Registered as unsupported, with no trainer: reinforcement learning, preference optimization, distillation, continual-learning rehearsal, self-supervised adaptation, and meta-learning. `GET /api/v1/training/methods` returns that registry to a reader with `training:read`.

## 18. Experiment planner

Weight Optimization recorded the six M7.5 regressions and the new development runs in `training_experiments`. Asked to plan with that history, a 40-step budget, and the historical base accuracy, the planner cites those six records, refuses another 80-step learning-rate 0.0001 run on about 25 examples, and recommends a zero-step control, a 5-step learning rate of 1e-5, a 250-example comparison with exposure stated separately, and a structured target. Every recommendation is `deployment: ineligible`. The same plan is in `planner.json`. A second call with the same history returns the same recommendations. Math cannot call the planner. A recommendation that begins with "Promote" is rejected, and the experiment id is not a model candidate.

## 19. Monitoring

The runner stopped further step extensions when development accuracy fell by more than 0.15. That prevented a longer 1e-4 run after the 10-step result of 19/64, and it recorded the 40-step 3e-5 collapse of 5/64 instead of continuing. A 201-step request is a budget stop in `monitoring.json`. The Monitoring agent can record the same regression stop through `POST /api/v1/training/experiments/stop`. Weight Optimization cannot. A run inside the tolerance returns 409. The stop record does not approve promotion.

## 20. Hypothesis verdicts

**H1, excessive updating, is supported.** Learning rate 1e-4 loses accuracy by 10 steps on 25 examples. Learning rate 3e-5 is near the base at 5 steps and down to 5/64 at 40 steps. Learning rate 1e-5 remains near 32/64 through 40 steps. The M7.5 setting, 80 steps at 1e-4, is past the point where this model already loses the task.

**H2, overfitting from repetition, is weakened as the main explanation.** At a non-damaging learning rate, 25 and 1,000 examples score the same. Matching exposure with a larger set made development accuracy worse, 27/64 rather than 32/64.

**H3, a train/eval mismatch, is weakened.** The zero-step adapter matches the base on development and on the fresh holdout. The rendered prompt, think prefix, and answer extraction are shared. The loss span is the verified target plus `<|im_end|>`.

**H4, answer-only targets, is weakened as a remedy.** Structured equations did not separate from answer-only training beyond one development item, and the fresh holdout gain is one item with p = 1. The damaging answer-only runs show that a large update can erase accuracy even when the target is the correct integer. Whether structured targets would survive 80 steps at 1e-4 was not run, because that region was already stopped.

**H5, the LoRA configuration, is unresolved for rank, scale, and layer choice.** Those were held at the M7.5 values. The loading path is weakened as a cause: an untrained adapter copies the base. Larger L2 movement lines up with the runs that lose accuracy.

**H6, dataset distribution, is weakened as the cause of the collapse.** More diverse data at a small update did not change the result, and the matched-exposure run did not help. The M7.5 examples may still differ from the holdout, but the step and learning-rate sweep changes the outcome while the data distribution is held fixed.

## 21. Automated tests

`pnpm test` passed after the experiments: 82 unit tests in 18 files, and 51 integration tests in 15 files. The new coverage includes exposure math, sealed-split rejection, planner reproducibility, the high-risk recommendation, budget withholding, stop conditions, structured solutions, method compatibility, idempotent experiment records, Monitoring's stop, and the refusal to promote.

## 22. Limitations

The selector is a deterministic policy over this arithmetic task. It is not evidence that Weight Optimization can improve its own training algorithm. The development rule called a one-item gain promising; the fresh holdout shows why that threshold is too weak to claim success. Retention is a short extraction and copy set. Rank, scale, and layer count were not ablated. Raw model outputs stay in the eval JSONL evidence store. Department history stores the summary, the hash, and the evidence path.

## 23. Completion

Engineering completion passed: real MLX training, a passed zero-step control, a token-level mask audit, raw JSONL, the method registry, experiment history, a reproducible planner, monitoring stops, the test suite, an independent fresh holdout, and no deployment.

Scientific completion failed. The frozen candidate does not beat the base by a distinguishable margin on the unseen holdout, on any of the three seeds.

## 24. Recommendation

Do not start dynamic department creation from this result. The useful next measurement is a task the base model actually fails, with the same zero-step control, a development stop when accuracy falls, and a holdout that is sealed before the final run. On this arithmetic task, updates large enough to move the loss quickly are also large enough to damage accuracy, and updates small enough to preserve accuracy do not improve it.

## Reproduction

```bash
pnpm exec tsx scripts/run-m75b.ts
pnpm exec tsx research/m75/score.ts services/training/results/m75b/evals
DATABASE_URL=postgres://colony:colony@127.0.0.1:5433/ai_colony pnpm exec tsx scripts/record-m75b-history.ts
pnpm test
```

The runner resumes from files already written. It does not rewrite `services/training/results/m75/`.
