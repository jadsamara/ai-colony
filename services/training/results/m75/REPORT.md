# M7.5 Phase 1 research report

Experiment `m75-phase1` started 2026-11-01T19:00:37.889Z. Phase 2 was not started. No adapter was promoted or assigned to an operational department.

## Model

Checkpoint `Qwen/Qwen3-1.7B-MLX-4bit`, revision `21457c6f51ed54a7c16e988c0844db973815c137`. Architecture Qwen3, 28 layers, quantization {"group_size":128,"bits":4}. Base weight hash `4d461171f280e0e4c925764d9805d83b9cd0930a7d2b237213ae7ae3fda23dcd`. Probe loss-mask target: `1000008<|im_end|>`. Probe peak memory 1197825330 bytes in 2246 ms.

The requested repository exists. This is not the mlx-community conversion. Thinking is constrained with a closed empty `<think>` prefix so training targets stay verified integers. mlx-community/Qwen3-0.6B-4bit was not used.

## Task

Selected cell `asm3-30` after development calibration. In band: true. Band missed: false. Combinatorial space 219501 supports the pre-registered 300-item holdout.

Generator `arith-m75-v1`. Scorer `answer-extract-m75-v1`. Sealed items: 300. OOD items: 80. Development baseline accuracy: 0.5833.

## Baseline sealed holdout

134/300 task-correct (0.4467), format 300/300, Wilson interval 0.3914–0.5032.

## Candidates

### self-101-r1

Condition self, seed 101, examples 27, steps 80, adapter `fe4c6ea20d89871e8c9dfa7dc7b675dbb5ffd4135dccb879f1e5d96330df9ef0`, train 6828 ms, peak 1247210336 bytes. Matched to the other condition: true.

Sealed 27/300 (0.0900). OOD 1/80 (0.0125). Baseline OOD 0/80 (0.0000).

Paired difference -0.3566666666666667, McNemar p 7.782297637007629e-25, research NEGATIVE_EVIDENCE, Bonferroni survivor true. Frozen M6 gate FAIL. Unchanged m7h policy VERIFIED_REGRESSION. Deployment ineligible.

Confirmatory retention: extraction 1 versus baseline 1; exact copy 1 versus baseline 1.

### supervised-101

Condition supervised, seed 101, examples 27, steps 80, adapter `65ce5be7e7191f2ec8b94356e31197988521178b44dee431aaeb2f118c509d58`, train 6815 ms, peak 1247210336 bytes. Matched to the other condition: true.

Sealed 37/300 (0.1233). OOD 3/80 (0.0375). Baseline OOD 0/80 (0.0000).

Paired difference -0.3233333333333333, McNemar p 3.593419195462763e-26, research NEGATIVE_EVIDENCE, Bonferroni survivor true. Frozen M6 gate FAIL. Unchanged m7h policy VERIFIED_REGRESSION. Deployment ineligible.

Confirmatory retention: extraction 1 versus baseline 1; exact copy 1 versus baseline 1.

### self-202-r1

Condition self, seed 202, examples 22, steps 80, adapter `4f81be735b79cb069b76eda860a97030ad5d9e4d95381e6620388340d87aec74`, train 6786 ms, peak 1247210336 bytes. Matched to the other condition: true.

Sealed 38/300 (0.1267). OOD 1/80 (0.0125). Baseline OOD 0/80 (0.0000).

Paired difference -0.32, McNemar p 1.9808264979368353e-22, research NEGATIVE_EVIDENCE, Bonferroni survivor true. Frozen M6 gate FAIL. Unchanged m7h policy VERIFIED_REGRESSION. Deployment ineligible.

Confirmatory retention: extraction 1 versus baseline 1; exact copy 1 versus baseline 1.

### supervised-202

Condition supervised, seed 202, examples 22, steps 80, adapter `b90db3f8d2fbe418d8105b9f9605ed63ded94fc372a92780b59cc5908052b1f9`, train 6773 ms, peak 1247210336 bytes. Matched to the other condition: true.

Sealed 29/300 (0.0967). OOD 2/80 (0.0250). Baseline OOD 0/80 (0.0000).

Paired difference -0.35, McNemar p 2.883015159390097e-23, research RETENTION_FAILURE, Bonferroni survivor true. Frozen M6 gate FAIL. Unchanged m7h policy VERIFIED_REGRESSION. Deployment ineligible.

Confirmatory retention: extraction 0.625 versus baseline 1; exact copy 1 versus baseline 1.

### self-303-r1

Condition self, seed 303, examples 25, steps 80, adapter `a3868e7417e965d8def216680c529684440043e0225e6e6504211875cb901f13`, train 6781 ms, peak 1247210336 bytes. Matched to the other condition: true.

Sealed 33/300 (0.1100). OOD 2/80 (0.0250). Baseline OOD 0/80 (0.0000).

Paired difference -0.33666666666666667, McNemar p 3.1646252204774417e-23, research NEGATIVE_EVIDENCE, Bonferroni survivor true. Frozen M6 gate FAIL. Unchanged m7h policy VERIFIED_REGRESSION. Deployment ineligible.

Confirmatory retention: extraction 1 versus baseline 1; exact copy 1 versus baseline 1.

### supervised-303

Condition supervised, seed 303, examples 25, steps 80, adapter `847570f119b1f6b8459f34a708f7b5513df2ca81ceca37c3fae75086e49f437e`, train 6773 ms, peak 1247210336 bytes. Matched to the other condition: true.

Sealed 54/300 (0.1800). OOD 5/80 (0.0625). Baseline OOD 0/80 (0.0000).

Paired difference -0.26666666666666666, McNemar p 4.377733803134624e-15, research NEGATIVE_EVIDENCE, Bonferroni survivor true. Frozen M6 gate FAIL. Unchanged m7h policy VERIFIED_REGRESSION. Deployment ineligible.

Confirmatory retention: extraction 1 versus baseline 1; exact copy 1 versus baseline 1.

## Reproducibility and scientific status

self: 3 confirmatory seeds, 0 with nominal positive evidence, 0 surviving Bonferroni (0.0083).
supervised: 3 confirmatory seeds, 0 with nominal positive evidence, 0 surviving Bonferroni (0.0083).

Scientific completion: FAIL. A single seed, a nominal p-value that does not survive the six-test Bonferroni correction, or a retention failure is not scientific completion. Engineering completion is recorded in the manifest only when this report was written after sealed evaluation.

## Yield

Seed 101: attempts 144, correct attempts 69, unique verified 28, matched 27, sufficient true, answer-cap dropped 0, easy-dominated false.
Seed 202: attempts 144, correct attempts 63, unique verified 24, matched 22, sufficient true, answer-cap dropped 0, easy-dominated false.
Seed 303: attempts 144, correct attempts 64, unique verified 27, matched 25, sufficient true, answer-cap dropped 0, easy-dominated false.

## Exploration

[{"round":1,"decision":{"continue":false,"reason":"development retention dropped by more than the tolerance"},"devAccuracy":0.08333333333333333}]

Later rounds, when trained, started again from the base checkpoint and were not scored on the sealed holdout.

## Policies

Frozen gate `m6-gate-v1` hash `82a3257e47c49f2a28a7c3bdd83806eebbc56c20824883f455fa35827895b7c7`. Improvement policy `m7h-improvement-v1` hash `c73976ddc5259e9b8810ffc3d9056da7a522495e3d1179a44ced427cabbf605c`. Neither policy was edited. Research conclusions do not require Wilson-interval separation. A safety-gate PASS is not an improvement. Phase 1 deployment eligibility is ineligible for every candidate.

## What this does not show

The colony did not run this training. Math did not receive the adapter. Qwen3-8B was not fine-tuned. A 1.7B adapter cannot be applied to Qwen3-8B. Self-generated targets are verified integers, not unverified reasoning traces. Arithmetic has exact programmatic labels, so a weak self-training result does not show that self-training is useless where labels are expensive. Retention on two short checks does not rule out forgetting in general. No claim is made about general intelligence or continual learning.

## Operational options, not implemented

Specialist routing could send arithmetic subtasks to this 1.7B checkpoint plus an adapter. That adds a second model in memory and needs its own sealed evaluation inside the Math workflow. Training a LoRA on operational Qwen3-8B would match the serving model but should not run while that 8B model is loaded, and it was not attempted. Either path needs a new authorization and a Phase 2 decision.

## Reproduction

```bash
pnpm exec tsx scripts/run-m75-phase1.ts
pnpm exec tsx research/m75/score.ts services/training/results/m75/evals
```

The scorer recomputes correctness from the prompt and the full response. Adapter weights remain under `services/training/research-artifacts` and are identified by SHA-256.

## Calibration record

The first ladder had no cell inside 0.30–0.60. `asm3-12` was the closest, at 11/16 (0.6875). That choice was discarded before any sealed item was scored. Three intermediate development cells were then measured: `as4-20` 0/16, `asm3-30` 5/16 (0.3125), and `as4-30` 0/16. `asm3-30` is inside the target band and is the frozen task. A seed-101 sample taken from the discarded `asm3-12` split was deleted and generated again. The sealed split used below belongs only to `asm3-30`.

The 16-item calibration estimate was 0.3125. The 48-item development baseline was 0.5833. The 300-item sealed baseline was 0.4467. The task was not changed after the development or sealed baselines were observed.

## Interpretation

Every confirmatory adapter is worse than the untouched base on the sealed holdout. The paired losses are about 0.27 to 0.36 accuracy, with exact McNemar p-values far below the Bonferroni threshold of 0.0083. The same direction appears in all three seeds and in both the self-verified and the programmatically supervised conditions. Example counts match within each seed (27, 22, and 25), and every run used 80 steps, rank 8, scale 2, and the last 8 `q_proj`/`v_proj` layers. This comparison does not show a benefit for self-generated data. It shows that this LoRA recipe damaged an existing partial skill. For the seed-101 self adapter, training loss fell to about 0.67 and validation loss to about 0.69 while sealed accuracy fell. Lower loss was not evidence of a better calculator. Training on the model's own verified successes was not uniquely responsible.

Out-of-distribution accuracy stays near the floor: the base model scored 0/80, and the best adapter scored 5/80. That is not a useful generalization result.

Unrelated retention stayed perfect for five of the six adapters. `supervised-202` fell from 16/16 to 10/16 on record extraction, which the research rule records as retention failure. These two short checks do not prove that other capabilities were preserved.

Development accuracy for the seed-101 self adapter was 0.0833 against a 0.5833 baseline, so the pre-registered stopping rule did not start a second or third self-training round. No later round was scored on the sealed holdout.

The independent scorer recomputed the sealed counts from the raw responses: baseline 134/300, self adapters 27/300, 38/300, and 33/300, supervised adapters 37/300, 29/300, and 54/300. Stored expected answers matched the expressions. No evaluation was marked invalid.

## Recommendation for a later experiment

Do not install these adapters, and do not start Phase 2 from them. A justified next experiment is a smaller update, chosen on development data only: a lower learning rate and fewer steps, because 80 updates at 0.0001 on about 25 examples coincided with collapse. A harder cell where the base model scores near zero is a different question and would need its own calibration; several four-term cells scored 0/16 here, so verified self-training yield may be too small there. Neither result says anything about a multi-agent colony advantage. H5 was not run.

