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

## 1d. vLLM primary — statistical gate sequence (STOP after each)

**Primary backend:** `vllm-batched` (`c18d1-statistical-eval-v1`).  
**Reference:** `huggingface-batched` (cross-check only).  
Exact greedy repeatability is **historical** (do not use as primary acceptance).

Fresh `C18D1_OUT` every run. Development items only. No locked access. No adapter promotion.

```bash
cd ~/ai-colony && git pull
export C18D1_VENV=~/ai-colony/tmp/c18d1/.venv-gpu
export C18D1_VLLM_VENV=~/ai-colony/tmp/c18d1/.venv-vllm
export C18D1_VLLM_PYTHON=~/ai-colony/tmp/c18d1/.venv-vllm/bin/python
export C18D1_PYTHON=~/ai-colony/tmp/c18d1/.venv-gpu/bin/python
export C18D1_SKIP_INSTALL=1   # unset on first venv create
export C18D1_SEED=18
export C18D1_PILOT_LIMIT=24
```

### Step 1 — Full-development noise floor (both modes)

Use a **fresh** `C18D1_OUT`. Entire `id_dev.jsonl` (500 items). Grader v3.2 + decoding-v2 (non-thinking 2048).  
Thinking reports **same-seed** (backend nondeterminism; promotion comparator) and **alternate-seed** (sampling variance).  
Do **not** treat the stratified 24-item 21.24% MDI as an automatic promotion threshold.

```bash
export C18D1_OUT=~/ai-colony/tmp/c18d1/noise-floor-full-dev-$(date +%Y%m%d-%H%M%S)
./scripts/c18d1-gpu-noise-floor-full-dev
# review: $C18D1_OUT/noise-floor-report.json
#   graderVersion=c18d1-grader-v3.2, decodingConfigVersion=c18d1-decoding-v2
#   sameSeedNoiseFloor vs alternateSeedNoiseFloor (thinking)
#   overallModelPromotionThreshold, minimumPracticallyMeaningfulImprovement
#   truncationByFamily / tokens — STOP for independent review
# Do NOT start stratified pilot or Stage B until approved
export C18D1_NOISE_FLOOR_REPORT=$C18D1_OUT/noise-floor-report.json
```

### Step 2 — Cross-backend check (vLLM vs HF)

Process-separated: vLLM phase exits (releases ~88 GiB) → HF in `.venv-gpu` → compare.
Preserve decoding/pins/seeds; do not lower `gpu_memory_utilization` for this fix.

```bash
export C18D1_OUT=~/ai-colony/tmp/c18d1/cross-backend-$(date +%Y%m%d-%H%M%S)
export C18D1_CONDITION=thinking_disabled_zero_shot
# C18D1_NOISE_FLOOR_REPORT must point at the reviewed v2 noise-floor report
./scripts/c18d1-gpu-cross-backend
# review: nvidia-smi after vLLM phase (memory released); then
#   $C18D1_OUT/cross-backend-report.json → statisticalGate.passed
#   gpuSequencing.vllmProcessExitedBeforeHf=true
# STOP — do not start Stage B from this step
```

### Step 3 — Stratified pilot (vLLM, both modes)

```bash
export C18D1_OUT=~/ai-colony/tmp/c18d1/vllm-stratified-pilot-$(date +%Y%m%d-%H%M%S)
export C18D1_PER_CELL=1
./scripts/c18d1-gpu-vllm-stratified-pilot
# review: $C18D1_OUT/eval/eval-report.json
#   conditions.thinking_* truncationByFamily, samplerImplementation, graderVersion=c18d1-grader-v3.1
# STOP — do not continue until reviewed
```

### Step 4 — Stage B full development baselines (vLLM)

```bash
export C18D1_OUT=~/ai-colony/tmp/c18d1/vllm-dev-baselines-$(date +%Y%m%d-%H%M%S)
./scripts/c18d1-gpu-vllm-dev-baselines
# review: $C18D1_OUT/eval/eval-report.json (both modes unless C18D1_CONDITION set)
# STOP — freeze strongest practical baseline from development metrics only
```

## 2. Stage C — locked (NOT before first adapter)

**Correction:** Stage C locked evaluation runs in the **same session** as the first trained adapter (base and adapter back-to-back on vLLM). Do **not** run locked baselines alone before that.

When ready (after a trained adapter exists):

```bash
# Same session: base eval → adapter LoRA eval → locked audit under Evaluation ACL
# Exact job JSON will be provided with the first adapter run; keep locked data under
# /var/lib/ai-colony/evaluation/c18d1-locked-v2 and publish aggregates only.
```

## 4. Phase 0 v3 report

Already recorded in-repo when present: `docs/milestones/C1_8D_PHASE0_GPU_RESULT_V3.json`. Do not invent results.
