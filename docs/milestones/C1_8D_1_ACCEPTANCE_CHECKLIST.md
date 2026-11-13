# C1.8D.1 — Milestone acceptance checklist

## Local (Mac / CI)

- [x] Repository audit + plan committed
- [x] HF revision pin mechanism (`pinned_revisions.json`, fail-closed)
- [x] SymPy generators + manifests (≥500/1000/300)
- [x] Overlap / duplicate audit passes
- [x] Strict parser + adversarial local tests
- [x] Locked-access unit tests (Evaluation-only)
- [x] Batched HF evaluator implemented (not yet GPU-run)
- [x] Stage A/B/C scripts + result templates
- [x] Autonomous Math training flag remains `false`
- [x] Production Ollama / DB / volumes untouched by this work

## Pending GPU acceptance (operator)

- [ ] `./scripts/c18d1-resolve-revisions` on GPU VM
- [ ] Stage A pilot completes; VRAM / tok/s / truncation recorded
- [ ] Stage B full development baselines recorded
- [ ] Strongest practical baseline frozen from **dev only**
- [ ] Stage C locked ID + OOD + regression under frozen config
- [ ] Metrics include accuracy, uncertainty, invalid/truncated, timing, tokens
- [ ] Copy Phase 0 v3 real report to `C1_8D_PHASE0_GPU_RESULT_V3.json` (do not invent)

## Must remain false

- Autonomous Math training launched
- Locked-test used for prompt/difficulty tuning
- Ollama substituted for pinned HF Qwen3-8B
- Milestone marked complete from local tests alone
