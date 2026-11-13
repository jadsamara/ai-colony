# C1.8D.1 — Versioned independent Math benchmark

**Benchmark version:** `c18d1-algebra-v1`  
**Generator version:** `c18d1-gen-v1`  
**Owner:** Evaluation department (`00000000-0000-4000-8000-000000000017`)

## Dataset sizes (generated)

| Split | Count | Path |
|---|---:|---|
| Development (10 ID families × 50) | 500 | `services/training/cuda/c18d1/datasets/dev/id_dev.jsonl` |
| Locked ID (10 × 100) | 1000 | `…/datasets/locked/id_locked.jsonl` |
| Locked OOD (3 × 100) | 300 | `…/datasets/locked/ood_locked.jsonl` |
| Regression | 120 | `…/datasets/regression/regression.jsonl` |

Manifests + overlap audit: `…/datasets/manifests/`.

## ID families

1. linear_equations  
2. linear_systems  
3. quadratic_equations  
4. polynomial_factorization  
5. rational_equations  
6. radical_equations  
7. absolute_value_equations  
8. inequalities  
9. exponential_log_equations  
10. symbolic_simplification  

Difficulty tiers (`easy` / `moderate` / `hard`) are structural (transforms, nesting, domain/extraneous traps). Definitions are frozen before locked evaluation (`difficultyFrozen: true` in the manifest). Ceiling families should be flagged from **development** results only.

## OOD families (structural, not seed variants)

| Family | Structural distinction |
|---|---|
| trigonometric_equations | Trig equations absent from ID families |
| linear_diophantine | Integer Diophantine constraints vs real closed-form algebra |
| piecewise_equations | Piecewise branch structure absent from ID templates |

## Access control

- Item-level locked prompts/answers/predictions: **Evaluation only**
- Learning agents may receive **approved aggregates** only (`public_aggregate_stub.json` pattern)
- Application gates: Python `access_control.py`, TypeScript `packages/core/src/evaluation/c18d1/access.ts`
- Residual risk: git clones can read JSONL offline — restrict training-agent repo access

## Answer format

Models must end with:

```text
ANSWER: <final mathematical answer>
```

Thinking-enabled: parse **after** `</think>` only. Never search the reasoning trace when the final answer is missing.

## Stages

| Stage | Script | Locked access |
|---|---|---|
| A Pilot | `./scripts/c18d1-gpu-pilot` | Dev only |
| B Dev baselines | `./scripts/c18d1-gpu-dev-baselines` | Dev only |
| C Locked baselines | `C18D1_BENCHMARK_FROZEN=1 ./scripts/c18d1-gpu-locked-baselines` | Evaluation role |

## Tool-assisted baseline

**Deferred.** No compatible SymPy tool-loop is wired for Math agents in this milestone. Track as a follow-up; not required to prove weight-level improvement.
