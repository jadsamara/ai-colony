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
- [x] Grader v3.4 (markdown-bold / extended LaTeX ANSWER; EmptySet-safe) + decoding-v2
- [x] Generator v3 exact `2**k` expectations; gen-v2 historical preserved
- [x] Independent weak-family audit v2 + offline regrade + blind-audit prepare tooling
- [x] HF reference provenance label fix (never `vllm-batched`)
- [x] Stage A/B scripts (vLLM) + result templates
- [x] Autonomous Math training flag remains `false`
- [x] Production Ollama / DB / volumes untouched by this work

## Pending GPU acceptance (operator)

- [x] Gemma 3 27B BF16 smoke (12/12 agree + parse) — passed
- [x] Full blind-audit CPU prepare (reconcile / provenance / composition / blindness / runtime)
- [x] Preflight: poly:0042 incomplete≠grader defect; 325-vs-307 composition explained
- [ ] Offline regrade of full-dev noise-floor artifacts + weak-family audit v2 — point prepare at live JSON
- [x] Full Gemma blind audit executed on GPU VM (325 packets; operator-reported)
- [x] CPU post-audit adjudication tooling (symmetry + review queue + summary)
- [ ] Human escalate unresolved disagreements from adjudication queue
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
