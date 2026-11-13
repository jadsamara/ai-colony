# C1.8D.1 — Exact GPU VM commands

Cursor cannot access the GPU VM. Run these on the Debian host.

## 0. Sync + pin revisions

```bash
cd /path/to/ai-colony
git pull
./scripts/c18d1-resolve-revisions
# confirm services/training/cuda/c18d1/pinned_revisions.json has 40-char hashes
```

## 1. Stage A — development pilot (ESTIMATES only)

```bash
export C18D1_OUT=/path/to/ai-colony/tmp/c18d1/pilot-$(date +%Y%m%d-%H%M%S)
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
export C18D1_CONDITION=thinking_enabled_zero_shot
export C18D1_PILOT_LIMIT=8
./scripts/c18d1-gpu-pilot
```

## 2. Stage B — full development baselines

```bash
export C18D1_OUT=/path/to/ai-colony/tmp/c18d1/dev-baselines-$(date +%Y%m%d-%H%M%S)
export C18D1_BATCH_SIZE=4
./scripts/c18d1-gpu-dev-baselines
```

Freeze strongest practical baseline from **development** metrics only. Do not open locked tests.

## 3. Stage C — locked baselines (after freeze)

```bash
export C18D1_BENCHMARK_FROZEN=1
export C18D1_CONDITION=thinking_enabled_zero_shot   # or frozen choice
export C18D1_OUT=/path/to/ai-colony/tmp/c18d1/locked-baselines-$(date +%Y%m%d-%H%M%S)
./scripts/c18d1-gpu-locked-baselines
```

Publish aggregates only. Keep `item-results.json` Evaluation-only.

## 4. Phase 0 v3 report (separate)

```bash
# On the VM, after Phase 0 v3 succeeded:
cp /path/to/tmp/c18d-phase0/gpu-controls-v3-*/phase0-report-v3.json \
  docs/milestones/C1_8D_PHASE0_GPU_RESULT_V3.json
```

Do not invent this file from chat summaries.
