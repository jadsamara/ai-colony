# C1.8D — Readiness report (grader v3.4 / gen-v3 / offline regrade)

**Status:** Corrections + reporting code landed. **STOP for independent review.**  
**Do not** start stratified pilot, Stage B, adapter training, Stage C, or promotion without explicit approval.

## Versions

| Component | Version | Notes |
|---|---|---|
| Grader | `c18d1-grader-v3.4` | Markdown-bold + `\textbf`/`\mathrm`/`\mathbf` ANSWER markers; prior artifacts not rescored in place |
| Generator | `c18d1-gen-v3` | Exact `2**k` expectations (no float) |
| Expected overlay | `c18d1-expected-exact-v1` | Prompt-based recovery for historical gen-v2 log items |
| Weak-family audit | `c18d1-weak-family-audit-v2` | Independent of grader wrong labels |
| Offline regrade | `c18d1-offline-regrade-v1` | CPU-only; fresh output dir |
| Blind LLM audit | `c18d1-blind-llm-audit-v1` | Prepare-only by default |

Historical gen-v2 development JSONL preserved at  
`services/training/cuda/c18d1/datasets/historical/id_dev.gen-v2.jsonl`.  
Locked sets untouched.

## Phase 1 — Defects corrected

1. **Independent weak-family audit** — `genuine_math_error` only when an independently extracted candidate is successfully compared and proven unequal. Historical `outcome=wrong` alone is insufficient; missing answers → `insufficient_response`.
2. **Marker extraction** — `**ANSWER: …**`, `**ANSWER:** …`, `\textbf{ANSWER:}`, `\mathrm{ANSWER:}`, `\mathbf{ANSWER:}` recognized; bare `ANSWER:` remains the format-compliance contract.
3. **Exact expectations** — `log(x)/log(2)=b` uses `exact_pow2(b)` (e.g. `2**-40` → `1/1099511627776`, `2**-24` → `1/16777216`, `2**63` → integer string). Regression tests cover these cases.

## Phase 2 — Offline regrade (operator)

CPU-only against **saved** `rawPrediction` fields:

```bash
cd ~/ai-colony && git pull --ff-only
export C18D1_NOISE_FLOOR_DIR=~/ai-colony/tmp/c18d1/noise-floor-full-dev-<timestamp>
./scripts/c18d1-offline-regrade-and-audit-prepare "$C18D1_NOISE_FLOOR_DIR"
```

Report fields: original vs corrected accuracy (both modes), per-family deltas, false-negative / false-positive grading-defect counts, remaining wrong/invalid/truncated/grader_error, provenance (grader + expected-correction + dataset paths). Historical eval files are not overwritten.

## Phase 3 — Blind LLM audit (prepare first)

Proposed reviewer (different family from Qwen):

| Field | Value |
|---|---|
| Model | `gpt-4o-mini` (OpenAI) |
| Sampling | temperature 0.0, maxTokens 400 |
| Cost | See `blind-audit-manifest.json` → `costEstimate` after prepare |

**Do not launch paid calls** until the estimate is approved and `C18D1_LLM_AUDIT_CONFIRM=1` is set. Execute path is intentionally gated; packets are written for offline/approved execution. LLM judgments are not ground truth and do not authorize promotion. Unresolved disagreements escalate to human review.

Coverage: all regraded wrong/invalid/truncated/grader_error; stratified 10% of regraded corrects by family × mode; transitions flagged as high-risk.

## Phase 4 — Readiness (current)

| Question | Answer |
|---|---|
| Corrected baselines available? | After operator runs offline regrade on VM artifacts |
| Per-family weaknesses? | Recompute from regrade + weak-family audit v2 |
| Remaining grader defects? | Any `grader_miss` / unresolved blind disagreements after regrade |
| Stratified pilot ready? | **Not yet** — blocked until regrade + audit review + explicit approval |
| Before Stage B | Pilot approval; no confirmed open grader misses; config freeze |

## Remaining acceptance gates

1. Independent review of this report + offline regrade numbers from VM.  
2. Approve or reject proposed blind-LLM reviewer/cost; run audit if approved.  
3. Human resolve unresolved disagreements.  
4. Explicit approval → stratified pilot (both modes) → **STOP**.  
5. Explicit approval → Stage B → freeze → **STOP**.  
6. Training / Stage C / promotion remain blocked.

**C1.9 continuous Evaluation architecture is out of scope for C1.8D.**

Autonomous Math training remains **false**.
