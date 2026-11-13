# C1.8D.1 — Versioned independent Math benchmark

**Benchmark version:** `c18d1-algebra-v2`  
**Generator version:** `c18d1-gen-v2`  
**Owner:** Evaluation department (`00000000-0000-4000-8000-000000000017`)

## Retired: `c18d1-algebra-v1` locked splits

Locked JSONL under `services/training/cuda/c18d1/datasets/locked/` for **v1** was tracked in git, including expected answers and `provenance.streamSeed`. **No locked evaluation had run.** Those splits are **retired** and must **never** be used for evaluation or training. See `datasets/manifests/RETIRED_LOCKED_V1.json`.

## Dataset layout (v2)

| Split | Count | Location |
|---|---:|---|
| Development (10 ID × 50) | 500 | In repo: `datasets/dev/id_dev.jsonl` |
| Regression | 120 | In repo: `datasets/regression/regression.jsonl` |
| Locked ID (10 × 100) | 1000 | **Outside repo** (Evaluation host) |
| Locked OOD (3 × 100) | 300 | **Outside repo** (Evaluation host) |

Commit-safe locked manifests only: `datasets/manifests/locked_v2_manifest.json` (counts, content hashes, generator version, **seed hash** — never raw seeds).

## Locked seed policy (v2)

- Seeds come only from outside the repo: `C18D1_LOCKED_SEED_FILE` (path outside repo) or `C18D1_LOCKED_SEED_ID` + `C18D1_LOCKED_SEED_OOD`.
- Generator **refuses** locked splits without them.
- Item provenance records `seedHash` only — never raw `streamSeed`.
- Data + item-level results: `C18D1_LOCKED_DATA_DIR` outside the repo and outside agent/department container mounts.

## Prompts

Prompts must not contain split names or `Instance:` tags. Instance identity lives in metadata/`id` only.

## ID / OOD families

Unchanged structural families from the milestone brief (10 ID + 3 OOD with trig / Diophantine / piecewise distinctions).

## Stages

| Stage | Script | Data |
|---|---|---|
| A Pilot | `./scripts/c18d1-gpu-pilot` | Dev only |
| B Dev baselines | `./scripts/c18d1-gpu-dev-baselines` | Dev only |
| Generate locked | `./scripts/c18d1-build-locked-datasets` | External dir |
| C Locked baselines | `C18D1_BENCHMARK_FROZEN=1 ./scripts/c18d1-gpu-locked-baselines` | External locked dir |

## Tool-assisted baseline

**Deferred.**
