# C1.8D.1 — Exact GPU VM commands

Repo on the VM: `~/ai-colony`. Cursor cannot access this host.

## 0. Sync + pin revisions

```bash
cd ~/ai-colony
git pull
./scripts/c18d1-resolve-revisions
# confirm ~/ai-colony/services/training/cuda/c18d1/pinned_revisions.json has 40-char hashes
```

## 0b. Create external locked seeds + data directory (Evaluation only)

```bash
# Directory outside the repo and outside agent/department mounts:
sudo mkdir -p /var/lib/ai-colony/evaluation
sudo chown "$USER":"$USER" /var/lib/ai-colony/evaluation
mkdir -p /var/lib/ai-colony/evaluation/c18d1-locked-v2
chmod 700 /var/lib/ai-colony/evaluation/c18d1-locked-v2

# Seed file OUTSIDE the repo (mode 600). Replace integers with Evaluation secrets.
cat > /var/lib/ai-colony/evaluation/c18d1-locked-seeds.json <<'EOF'
{"locked_id": 918273645, "locked_ood": 564738291}
EOF
chmod 600 /var/lib/ai-colony/evaluation/c18d1-locked-seeds.json

cd ~/ai-colony
export C18D1_LOCKED_SEED_FILE=/var/lib/ai-colony/evaluation/c18d1-locked-seeds.json
export C18D1_LOCKED_DATA_DIR=/var/lib/ai-colony/evaluation/c18d1-locked-v2
export C18D1_WRITE_REPO_MANIFESTS=1
./scripts/c18d1-build-locked-datasets
# JSONL + results under /var/lib/ai-colony/evaluation/c18d1-locked-v2
# Commit-safe manifest written to:
#   ~/ai-colony/services/training/cuda/c18d1/datasets/manifests/locked_v2_manifest.json
```

Alternative (env vars instead of a file):

```bash
export C18D1_LOCKED_SEED_ID=918273645
export C18D1_LOCKED_SEED_OOD=564738291
export C18D1_LOCKED_DATA_DIR=/var/lib/ai-colony/evaluation/c18d1-locked-v2
export C18D1_WRITE_REPO_MANIFESTS=1
cd ~/ai-colony
./scripts/c18d1-build-locked-datasets
```

After reviewing the commit-safe manifest, commit it from a trusted Evaluation checkout if desired. Never commit seed files or locked JSONL.

## 1. Stage A repair — pull, batch-invariance, re-pilots

Use a **fresh** `C18D1_OUT` for every run. Do not overwrite prior Stage A reports.

```bash
cd ~/ai-colony
git pull
# confirm commit includes c18d1-batched-eval-v4 / c18d1-batch-invariance-v3
```

### 1a. Batch-invariance Gate v3 (mandatory; fresh output dir)

```bash
cd ~/ai-colony
export C18D1_OUT=~/ai-colony/tmp/c18d1/batch-invariance-v3-$(date +%Y%m%d-%H%M%S)
export C18D1_PILOT_LIMIT=24
export C18D1_GATE_VERSION=c18d1-batch-invariance-v3
export C18D1_SKIP_INSTALL=1   # omit on first setup
./scripts/c18d1-gpu-batch-invariance
# require: $C18D1_OUT/batch-invariance-report.json → passed=true
# gateVersion: c18d1-batch-invariance-v3
# pass: no artifacts + position_ids aligned + 100% canonical answer agreement
#       + 100% graded-outcome agreement + same-config bs4 repeatability
# logit/KL fields are diagnostics only; do not overwrite prior v2 failure reports
```

Optional: re-run preserved Gate v2 (historical criterion only; expect failure under prior GPU conditions):

```bash
export C18D1_OUT=~/ai-colony/tmp/c18d1/batch-invariance-v2-rerun-$(date +%Y%m%d-%H%M%S)
export C18D1_GATE_VERSION=c18d1-batch-invariance-v2
./scripts/c18d1-gpu-batch-invariance
```

### 1b. Thinking-disabled pilot (re-run)

```bash
cd ~/ai-colony
export C18D1_OUT=~/ai-colony/tmp/c18d1/pilot-td-v2-$(date +%Y%m%d-%H%M%S)
export C18D1_PILOT_LIMIT=24
export C18D1_BATCH_SIZE=4
export C18D1_CONDITION=thinking_disabled_zero_shot
export C18D1_SKIP_INSTALL=1
./scripts/c18d1-gpu-pilot
# report: $C18D1_OUT/eval-report.json
# check: mathematicalAccuracy, formatComplianceRate, thinkingModeProtocolViolations,
#        graderVersion=c18d1-grader-v2, specVersion=c18d1-batched-eval-v4
```

### 1c. Thinking-enabled pilot (re-run)

```bash
cd ~/ai-colony
export C18D1_CONDITION=thinking_enabled_zero_shot
export C18D1_PILOT_LIMIT=8
export C18D1_BATCH_SIZE=4
export C18D1_OUT=~/ai-colony/tmp/c18d1/pilot-te-v2-$(date +%Y%m%d-%H%M%S)
export C18D1_SKIP_INSTALL=1
./scripts/c18d1-gpu-pilot
# must not raise: model_kwargs unused ['generator']
```

**Resource estimates (not measured in this Cursor session):**

- VRAM: ~10–20 GB for Qwen3-8B bf16 + small batch (left-padded).
- Thinking-enabled pilot will use more tokens/latency; start with disabled for smoke.
- If OOM: lower `C18D1_BATCH_SIZE` to 1–2.

Gate v3 GPU PASS is recorded in `C1_8D_1_BATCH_INVARIANCE_GATE_V3_GPU_PASS.md` (operator-measured).

## 1d. Development foundation — stratified pilot + vLLM (STOP after review)

Do **not** start Stage B/C. Fresh dirs only. Official backend remains HF.

Generated `tmp/…/selection/stratified_pilot.jsonl` files are accepted only with a verified
`stratified_selection_manifest.json` bound to `datasets/dev` (shared provenance validator).

If `C18D1_SKIP_INSTALL=1`, ensure the venv already has **sympy** (and torch/transformers);
scripts run `deps_preflight.py` first.

```bash
cd ~/ai-colony && git pull

# If prior SKIP_INSTALL left sympy missing:
#   source ~/ai-colony/tmp/c18d1/.venv-gpu/bin/activate
#   pip install -r services/training/cuda/requirements-c18d1.txt

# Stratified Stage A (HF official) — 10 families × 3 difficulties
export C18D1_OUT=~/ai-colony/tmp/c18d1/stratified-pilot-$(date +%Y%m%d-%H%M%S)
export C18D1_PER_CELL=1
export C18D1_BATCH_SIZE=4
export C18D1_CONDITION=thinking_disabled_zero_shot
export C18D1_SKIP_INSTALL=1
./scripts/c18d1-gpu-stratified-pilot
# review: $C18D1_OUT/eval/eval-report.json, projections.json, reproducibility-manifest.json

# HF vs vLLM thinking-enabled benchmark (vLLM uses a SEPARATE venv)
export C18D1_OUT=~/ai-colony/tmp/c18d1/backend-bench-$(date +%Y%m%d-%H%M%S)
export C18D1_PILOT_LIMIT=8
export C18D1_MAX_NEW_TOKENS=2048
export C18D1_SAMPLES_PER_PROBLEM=1
export C18D1_BACKENDS=huggingface,vllm
export C18D1_VENV=~/ai-colony/tmp/c18d1/.venv-gpu
export C18D1_VLLM_VENV=~/ai-colony/tmp/c18d1/.venv-vllm
export C18D1_VLLM_PYTHON=~/ai-colony/tmp/c18d1/.venv-vllm/bin/python
export C18D1_SKIP_INSTALL=1   # unset on first vLLM venv create
./scripts/c18d1-gpu-backend-benchmark
# review: $C18D1_OUT/backend-benchmark-report.json (graderVersion=c18d1-grader-v3)

# vLLM same-config repeatability (C18D1_VLLM_PYTHON only — never .venv-gpu)
export C18D1_OUT=~/ai-colony/tmp/c18d1/vllm-repeatability-$(date +%Y%m%d-%H%M%S)
export C18D1_PILOT_LIMIT=24
export C18D1_MAX_NEW_TOKENS=512
export C18D1_VLLM_PYTHON=~/ai-colony/tmp/c18d1/.venv-vllm/bin/python
export C18D1_SKIP_INSTALL=1
./scripts/c18d1-gpu-vllm-repeatability
# review: eligibleAsOfficialBackend; libraries.vllm / libraries.torch recorded
```

**STOP** after these three runs for human review. No Stage B/C, locked access, training, or adapter promotion.

## 2. Stage B — full development baselines

```bash
cd ~/ai-colony
export C18D1_OUT=~/ai-colony/tmp/c18d1/dev-baselines-$(date +%Y%m%d-%H%M%S)
export C18D1_BATCH_SIZE=4
./scripts/c18d1-gpu-dev-baselines
```

Freeze strongest practical baseline from **development** metrics only. Do not open locked tests.

## 3. Stage C — locked baselines (after freeze)

```bash
cd ~/ai-colony
export C18D1_BENCHMARK_FROZEN=1
export C18D1_LOCKED_DATA_DIR=/var/lib/ai-colony/evaluation/c18d1-locked-v2
export C18D1_CONDITION=thinking_enabled_zero_shot   # or frozen choice
export C18D1_OUT=/var/lib/ai-colony/evaluation/c18d1-locked-v2/results/baselines-$(date +%Y%m%d-%H%M%S)
./scripts/c18d1-gpu-locked-baselines
```

Publish aggregates only. Keep item-level artifacts under `/var/lib/ai-colony/evaluation/…`.

## 4. Phase 0 v3 report

Already recorded in-repo when present: `docs/milestones/C1_8D_PHASE0_GPU_RESULT_V3.json`. Do not invent results.
