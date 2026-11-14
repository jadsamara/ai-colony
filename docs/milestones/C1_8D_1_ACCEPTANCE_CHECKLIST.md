# C1.8D.1 — Milestone acceptance checklist

## Local (Mac / CI)

- [x] Repository audit + plan committed
- [x] HF revision pin mechanism (`pinned_revisions.json`, fail-closed)
- [x] SymPy generators + public manifests (500 dev / 120 regression)
- [x] Locked v1 retired (removed from git tree; never evaluate/train)
- [x] Locked v2 external-seed generator (out-of-repo data; commit-safe manifests only)
- [x] Overlap / duplicate audit passes (public splits)
- [x] Strict parser + adversarial local tests
- [x] Locked-access unit tests (Evaluation-only)
- [x] Tests: no locked files tracked; prompts lack split tags; locked gen refuses without seed
- [x] Batched HF evaluator implemented (reference cross-check)
- [x] vLLM primary eval + statistical gate v1 + noise floor + cross-backend
- [x] Grader v3.3 (EmptySet-safe; `\text{ANSWER:}` from v3.2) + decoding-v2 (non-thinking 2048)
- [x] HF reference provenance label fix (never `vllm-batched`)
- [x] Stage A/B scripts (vLLM) + result templates
- [x] Autonomous Math training flag remains `false`
- [x] Production Ollama / DB / volumes untouched by this work

## Pending GPU acceptance (operator)

- [ ] Full-development noise floor reviewed (thinking ~94.8–95.4%; flips ~10%) — methodology update landed
- [ ] Family diagnostics + weak-family audit JSON generated from VM artifacts — **STOP for review**
- [ ] Confirmed grader misses fixed (versioned) before Stage B, if any
- [ ] Stratified pilot (vLLM, both modes) — only after explicit approval — **STOP**
- [ ] Stage B full development baselines (vLLM) — only after pilot approval — **STOP for freeze**
- [ ] Stage C locked ID/OOD + regression **only in same session as first trained adapter**
- [ ] Metrics include accuracy, uncertainty, invalid/truncated/grader_error, timing, tokens, samplerImplementation
- [ ] Copy Phase 0 v3 real report to `C1_8D_PHASE0_GPU_RESULT_V3.json` (do not invent)

## Must remain false

- Autonomous Math training launched
- Locked-test used for prompt/difficulty tuning
- Ollama substituted for pinned HF Qwen3-8B
- Milestone marked complete from local tests alone
