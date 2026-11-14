# C1.8D.1 — Thinking-mode noise-floor review (methodology + gates)

**Status:** Documentation / reporting update only. **STOP for independent review.**  
**Do not** start stratified pilot, Stage B, training, Stage C, or promotion without explicit approval.  
**Do not** change decoding config or rerun GPU evaluations without approval.

**Grader at review:** `c18d1-grader-v3.3`  
**Decoding:** `c18d1-decoding-v2` (thinking `samplesPerProblem=3` unchanged)  
**Primary backend:** `vllm-batched` · **Reference:** `huggingface-batched`

---

## 1. Operator-reported full-dev thinking noise floor (aggregates)

From the successful full-development noise-floor run (operator review):

| Metric | Value |
|---|---|
| Thinking-enabled accuracy (paired runs) | **94.8% / 95.4%** |
| Same-seed graded-outcome item flips | **51 / 500 (10.2%)** |
| Alternate-seed graded-outcome item flips | **49 / 500 (9.8%)** |

These aggregates are recorded here for methodology decisions. Item-level family tables and weak-family samples are produced from the run’s `item-results-*.json` via:

```bash
# On the GPU VM, pointing at the reviewed noise-floor output directory:
export C18D1_NOISE_FLOOR_DIR=~/ai-colony/tmp/c18d1/noise-floor-full-dev-<timestamp>

python3 services/training/cuda/c18d1/family_diagnostics.py \
  --artifact-dir "$C18D1_NOISE_FLOOR_DIR" \
  --out "$C18D1_NOISE_FLOOR_DIR/family-diagnostics-report.json"

python3 services/training/cuda/c18d1/weak_family_audit.py \
  --artifact-dir "$C18D1_NOISE_FLOOR_DIR" \
  --dataset services/training/cuda/c18d1/datasets/dev/id_dev.jsonl \
  --sample-size 10 --seed 18 \
  --out "$C18D1_NOISE_FLOOR_DIR/weak-family-audit-report.json"
```

Copy those JSON reports into Evaluation storage; do not invent item-level rows in git.

---

## 2. Thinking-mode evaluation methodology (updated)

### Variability reference

| Floor | Meaning | Role |
|---|---|---|
| **Alternate-seed** | Different seed schedules (sampling variance under stochastic policy) | **Promotion reference** for thinking-enabled base-vs-adapter |
| **Same-seed** | Identical seed schedule, two runs (backend nondeterminism) | **Diagnostic only** for thinking |

Thinking-disabled (greedy) continues to use the **same-seed** floor.

### Sampling schedule and seed limitations

- Schedule: `sampling_seed_schedule(baseSeed, itemIndex, sampleIndex)`.
- Each request records `SamplingParams(seed=…)`.
- **Limitation:** vLLM continuous batching does **not** guarantee per-request seed pairing or bit-identical regeneration. Seeds express matched-schedule *intent*, not exact reproducibility.
- Current config: `samplesPerProblem=3` (frozen until an approved decoding version bump).

### Proposed ≥4 generations per item (advisory)

`THINKING_ENABLED.proposedSamplesPerProblem = 4` is documented only.

**Uncertainty note (item-clustered):** extra draws shrink *within-item* variance of the item-mean accuracy, but the independent unit remains the **item** (\(n=500\) on full-dev). Moving 3→4 samples does **not** multiply the effective sample size by 4/3 for inference. Material CI narrowing requires either more independent items or a measured reduction in within-item discordance—evaluate empirically before changing the frozen config.

### Statistics

- Use **item-clustered** paired statistics (`c18d1-paired-stats-v2`).
- Do **not** treat multiple generations of one item as independent benchmark questions.
- Report flip rates, CIs, paired Δ, and per-family outcomes; state `noiseFloorKindComparedAgainst`.

---

## 3. Per-family diagnostics

Structure (both modes; same schema):

- `accuracy`, `correct`, `wrong`, `invalid`, `truncated`, `grader_error`
- `missingFinalAnswerCount` / `missingFinalAnswerRate`
- `generatedTokens` / `runtimeMs` summaries (`mean`, `p50`, `p90`, `max`)

Tooling: `family_diagnostics.py` (reads existing artifacts only).

---

## 4. Improvement and promotion criteria

| Layer | Policy |
|---|---|
| Overall practical improvement | **+5 percentage points** (`minimumPracticallyMeaningfulImprovement=0.05`) — preserved |
| Thinking overall headroom | ~95% accuracy ⇒ very little overall headroom; overall +5pp is often **impractical** as the sole success definition |
| Family-level criteria | Pre-register targets for weak families **before** seeing adapter results (see below) |
| Overall non-regression | Required on full-dev (both modes as applicable) |
| Thinking-enabled regression | **Mandatory** for every adapter (matched config) |
| Promotion | **Admin-approved only**; family-level gain never auto-promotes |

### Pre-registered family-level criteria (proposal)

Applies only after Stage B freeze and an approved training design. Defaults:

1. **Independent items:** ≥50 development items per targeted family (full-dev cells), or a pre-declared stratified subset with fixed IDs.
2. **Primary estimand:** item-clustered paired accuracy difference vs frozen thinking-disabled (or thinking-enabled) baseline as declared in the experiment card.
3. **Uncertainty:** item-clustered bootstrap CI; require CI lower bound > 0 **and** point estimate ≥ pre-registered δ_family (suggested default δ_family = 0.05 absolute within family, or MDI_family if larger).
4. **Multiple comparisons:** control family-wise error via Bonferroni over the **pre-registered** family set only (not post-hoc fishing). Exploratory families are labeled non-confirmatory.
5. **Non-regression:** overall thinking-enabled accuracy must not fall by more than the alternate-seed noise floor (point estimate), and regression suite must pass.
6. **No auto-promotion** from family wins alone.

---

## 5. Proposed first training experiment (design only — not implemented)

**Goal:** Improve **thinking-disabled** Qwen3-8B on weak mathematical families using independently verified answers from **thinking-enabled** Qwen3-8B (same pinned revision).

| Element | Requirement |
|---|---|
| Data | **Training-only** problems; disjoint from `id_dev`, locked ID/OOD, and regression streams |
| Teacher | Thinking-enabled Qwen3-8B (pinned); generate candidates |
| Verification | SymPy `grade_answer` + generator constraints; drop incorrect / ambiguous / unverifiable |
| Student format | Thinking-disabled; final `ANSWER:` line; **no** teacher reasoning traces in student targets (answer-only SFT) unless a separate approved trace experiment is declared |
| Baseline | Frozen thinking-disabled Stage B baseline (after approval / freeze) |
| Mandatory eval | Thinking-enabled regression on development (and later locked only with first adapter session) |
| Compute budget | Cap GPU-hours and steps in the experiment card before launch |
| Stopping | Early-stop on validation family metric plateau or budget exhaustion |
| Failure | No promotion if overall non-regression fails, thinking regression fails, or verification yield too low |

**Not started.** No training code execution in this update.

---

## 6. Weak-family audit (both modes)

Families: `exponential_log_equations`, `polynomial_factorization`, `quadratic_equations`, `symbolic_simplification`.

- Sample **10** wrong/invalid/(grader_error) outputs per family per mode from existing artifacts.
- Record expected vs parsed answer; classify `genuine_math_error` | `grader_miss` | `needs_human_review`.
- **Any confirmed `grader_miss` ⇒ versioned grader fix before Stage B.**

Tooling: `weak_family_audit.py`.

---

## 7. Grader robustness

Per-item grading exceptions → outcome **`grader_error`** (counted separately; raw output logged; run continues). Covered by CPU regression test.

---

## 8. Remaining C1.8D acceptance gates

1. Independent review of this methodology update + family/weak-family reports from VM artifacts.  
2. Confirmed grader misses fixed (versioned) if audit finds any.  
3. Stratified pilot (both modes) — **only after approval**.  
4. Stage B full-dev baselines — **only after pilot approval** → freeze.  
5. Training / Stage C / promotion — **blocked** until later explicit approvals.

**Autonomous Math training remains false.**
