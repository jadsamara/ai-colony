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

## 1. Stage A — development pilot (ESTIMATES only)

```bash
cd ~/ai-colony
export C18D1_OUT=~/ai-colony/tmp/c18d1/pilot-$(date +%Y%m%d-%H%M%S)
export C18D1_PILOT_LIMIT=24
export C18D1_BATCH_SIZE=4
export C18D1_CONDITION=thinking_disabled_zero_shot
./scripts/c18d1-gpu-pilot
# report: $C18D1_OUT/eval-report.json
```

**Resource estimates (not measured in this Cursor session):**

- VRAM: ~10–20 GB for Qwen3-8B bf16 + small batch (left-padded).
- Thinking-enabled pilot will use more tokens/latency; start with disabled for smoke.
- If OOM: lower `C18D1_BATCH_SIZE` to 1–2.

Optional thinking pilot:

```bash
cd ~/ai-colony
export C18D1_CONDITION=thinking_enabled_zero_shot
export C18D1_PILOT_LIMIT=8
export C18D1_OUT=~/ai-colony/tmp/c18d1/pilot-think-$(date +%Y%m%d-%H%M%S)
./scripts/c18d1-gpu-pilot
```

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
