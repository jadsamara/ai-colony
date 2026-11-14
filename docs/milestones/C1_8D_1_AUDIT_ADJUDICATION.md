# C1.8D — Post-audit adjudication (CPU only)

**Status:** Tooling ready. **STOP** before Stage B / training / promotion.  
Does **not** modify official grades. Gemma is never ground truth.

## Operator-reported full-audit totals (GPU VM)

| Metric | Count |
|---|---|
| Packets | 325 |
| Parseable judgments | 305 |
| Parse failures | 20 |
| Disagreements | 80 (all Gemma `correct` vs deterministic `wrong`) |
| `disagree_exact_check_applied` | 25 |
| `escalate_human_review` | 55 |
| Automated grader FP/FN candidates | 0 |

Exp/log family accounts for 45 of 80 disagreements — prioritize those in the review queue.

## Scoring symmetry

`score_judgment` flags disagreement for **both**:

- reviewer `correct` / grader `wrong`
- reviewer `incorrect` / grader `correct`

When the candidate is not independently comparable, `independentEqual` is **`null`** (not `false`). Do **not** treat `independentEqual=false` alone as proof Gemma erred.

## CPU adjudication

```bash
# On the GPU VM (no new inference):
cd ~/ai-colony && git pull --ff-only
./scripts/c18d1-adjudicate-gemma-audit \
  ~/ai-colony/tmp/c18d1/gemma-smoke-20261114-215916/gemma-full-audit-report.json
# review:
#   $C18D1_OUT/adjudication-summary.json
#   $C18D1_OUT/adjudication-review-queue.jsonl
#   $C18D1_OUT/ADJUDICATION_REPORT.md
```

Local fixture (no VM file):

```bash
python3 services/training/cuda/c18d1/audit_adjudication.py \
  --fixture --out /tmp/c18d1-adjudication-fixture
```

Outputs:

- `adjudication-summary.json` — counts reconciling to packet total
- `adjudication-review-queue.jsonl` — problem, raw response, expected, Gemma judgment, independent evidence, label (exp/log first)
- `adjudication-disagreements.json` / `adjudication-parse-failures.json` / `adjudication-exp-log.json`
- `ADJUDICATION_REPORT.md`

## Parse-failure taxonomy

`empty_response` · `malformed_json` · `truncated_json` · `no_json_object` · `refusal_or_policy` · `transport_or_api_error` · `unparseable_other`

## Policy

- No GPU / no redownload / no new Qwen or Gemma calls
- No locked-test access
- No official grader change without a separately reviewed, versioned defect fix
- Unresolved escalations stay human-review
- Numerical approximations alone are not definitive proof
