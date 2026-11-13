# C1.9 — Target architecture and dependency map

**Status:** Architecture decision adopted. **No C1.9 implementation in this document.**  
**Prerequisite:** Document C1.8D state and dependencies before coding C1.9A–F.

---

## 1. Adopted target architecture

**Primary objective.** Departments independently communicate, identify problems, develop and test code, train and evaluate models, adopt improvements, and create new departments without routine human direction.

| Domain | Target rule |
|---|---|
| **Governance** | CEO has final authority over department creation. Budget & Resources manages allocation with least privilege. Memory & Forgetting records experience and performance. Evaluation independently verifies improvements. |
| **Protected infrastructure** | Evaluator, grader, benchmarks, locked data, budget caps, kill switches, permissions, governance rules, promotion gates, backups, rollback, and the protected-path policy itself. Departments may **propose** changes; only an authenticated administrator may **apply** them. Enforce protections **outside** writable colony environments. |
| **Autonomous engineering** | Isolated workspaces, automated testing, independent review, staged deployment, health checks, rollback. Start with reviewed changes; later allow automatic deploy only for explicitly classified low-risk changes. |
| **Autonomous model acquisition** | Verified sources, pinned revisions, approved formats, license verification, sandbox testing, resource quotas. Never execute untrusted repository code. Escalate unverified or exceptional acquisitions. |
| **Autonomous learning** | Departments may propose training, choose candidates, run experiments, and adopt **independently verified** improvements without routine admin approval — subject to protected gates and track-record rules below. |
| **Communication** | Departments may initiate conversations voluntarily. Provide a persistent live channel where the authenticated administrator can observe and participate. |

### Binding constraints (from architecture decision)

1. **C1.9A–C** may start after C1.8D **completes**, regardless of Math-cycle outcome.
2. **C1.9D** (autonomous training/adoption) starts only after the first Math training cycle either **shows improvement** or its **failure cause is documented**.
3. Automatic adoption decisions use **development** and a separate **adoption set** — **never** the locked test. Locked tests run only as periodic independent audits and are refreshed with newly generated items on a documented schedule.
4. Model promotion requires **admin approval** until a **track-record rule** is met (e.g. N adoptions where the periodic audit confirmed the gate). The rule itself is **protected**.
5. CEO-authorized department creation is bounded by **protected limits**: max department count, per-department GPU/memory, total budget.

### Explicit non-duplication

Do **not** create parallel departments, registries, memory systems, sandbox runners, evaluation gates, or messaging buses. Extend existing packages under `packages/core`, `packages/contracts`, `packages/database`, `packages/messaging`, `services/training`, and `apps/api`.

---

## 2. C1.8D current state (prerequisite for C1.9)

### 2.1 What C1.8D has delivered

| Slice | State | Notes |
|---|---|---|
| **Phase 0** (PEFT positive controls) | GPU evidence present (`C1_8D_PHASE0_GPU_RESULT_V3.json`); unlock still fail-closed via `phase0-gate.ts` count revalidation | Does **not** unlock Math learning |
| **C1.8D.1 foundation** | Local code complete: pins, SymPy generators, grader v3.1, HF batched eval, locked ACL, stratified pilots, accounting, Gate v3, vLLM experimental path | See checklist |
| **Gate v3 batch-invariance** | Operator GPU PASS documented (HF historical path) | Preserved; not overwritten |
| **Statistical gate v1** | Code landed (`c18d1-statistical-eval-v1`); GPU acceptance pending | Primary backend = `vllm-batched`; HF = reference |
| **Grader** | `c18d1-grader-v3.1` (interval float≡rational fix) | Do not silently rescore older reports |
| **Autonomous Math training** | **Disabled** — `C18D1_AUTONOMOUS_MATH_TRAINING_ENABLED = false` | Hard constraint for C1.8D.1 |

### 2.2 What remains before “C1.8D complete”

Per `C1_8D_1_ACCEPTANCE_CHECKLIST.md` (operator GPU work; do not invent results):

| Remaining work | Blocks |
|---|---|
| Noise floor + cross-backend statistical gate GPU pass | Primary backend acceptance |
| Stage A stratified pilot on vLLM (thinking + non-thinking) | Baseline evidence |
| Stage B full development baselines on vLLM | Freeze strongest practical **dev** baseline |
| Stage C locked ID/OOD + regression **in same session as first trained adapter** | Independent audit (not before adapter) |
| First **Math training cycle** (train → eval → record) with either measured improvement **or** documented failure cause | **C1.9D start gate** |

**C1.8D “complete” for starting C1.9A–C** means: Stage A/B/C acceptance recorded (pass or fail with evidence), locks untouched by training, autonomous Math flag still false until C1.9D prerequisites.  
**C1.8D “Math cycle done” for C1.9D** means: one closed train/eval loop with improvement **or** written failure analysis.

### 2.3 C1.8D dependency graph (do not rebuild)

```
Evaluation dept (…000017) ──owns──► locked v2 + grader + promotion gates
Math dept (…000019) ───────uses──► development / adoption data only
Weight Optimization (…000015) ► proposes training; no locked item access
Phase 0 PEFT (cuda/) ──────► trainer patterns; not Math-task proof
C1.8C sandbox ─────────────► CPU isolated dry-run; GPU-disabled for colony path
HF pin (pinned_revisions.json) ► Qwen3-8B @ fixed commit; Ollama forbidden for eval
Gate v2/v3 reports ────────► historical; never overwrite
stats.ts / paired.ts ──────► Wilson, McNemar (reuse for C1.9 adoption evidence)
```

### 2.4 Open C1.8D risks that C1.9 must not paper over

- Exact greedy repeatability under continuous batching is **not** assumed; any vLLM-primary path needs a **versioned statistical gate**, not silent criterion weakening.
- Locked tests must remain Evaluation-only and out of iterative tuning/adoption loops.
- Production Ollama serving must stay isolated from experimental adapters until promotion rules fire.

---

## 3. Incremental slices C1.9A–F

| Slice | Theme | Start gate |
|---|---|---|
| **C1.9A** | Protected infrastructure, CEO department-creation bounds, kill switches, permissions hardening | After C1.8D complete |
| **C1.9B** | Autonomous engineering (workspaces, test, review, staged deploy, rollback) | After C1.8D complete |
| **C1.9C** | Voluntary inter-dept communication + live admin observation channel | After C1.8D complete |
| **C1.9D** | Autonomous training / adoption / track-record promotion | After Math cycle improvement **or** failure documented |
| **C1.9E** | Autonomous model acquisition (verify, pin, license, sandbox, quota) | After C1.8D complete (may parallel A–C; no untrusted exec) |
| **C1.9F** | Live Budget & Resources enforcement + Memory experience/performance productization | After C1.8D complete; integrates with A/D gates |

Order is incremental, not strictly serial for A/B/C/E/F. **D is hard-gated.**

---

## 4. Dependency map — exists / modify / missing

Legend: **E** = exists and should be reused · **M** = exists but needs modification · **N** = missing (build in C1.9)

### 4.1 Governance and protected infrastructure (C1.9A)

| Capability | Status | Location / note |
|---|---|---|
| Department registry + lifecycle | **E** | `department-service.ts`, `transitions.ts`, seed (13 depts) |
| CEO / Evolution propose org change | **E** | seed roles; approvals |
| Permanent dept change = system administrator | **E** | `self-protection.ts` (CEO ≠ admin apply) |
| Permission catalog + authorizer | **E** | `permissions.ts`, `authorizer.ts` (~70 perms) |
| Append-only audit | **E** | audit events / query services |
| Protected-path policy (grader, locks, gates, backups) as first-class object | **N** | Policy exists in docs/flags; need durable protected registry + enforce **outside** writable workspaces |
| Colony-wide kill switch (halt train/infer/deploy) | **N** / partial | Autonomy pause exists; Phase 0 plan lists kill switches as future |
| Protected limits: max depts, per-dept GPU/mem, total budget | **N** | Budget schema exists; hard caps + CEO create bounds missing |
| Admin-only apply path for protected proposals | **M** | Approvals exist; wire “propose vs apply” to protected catalog |
| Engineering department as first-class seed | **M** / **N** | Slug appears in learning maps; **not** in `INITIAL_DEPARTMENTS` — add only if needed, do not duplicate Math/WO |

### 4.2 Budget & Resources (C1.9F primary; bounds in A)

| Capability | Status | Location / note |
|---|---|---|
| Resource / parameter budget schemas | **E** | `packages/contracts/.../budget.ts` |
| Agent ⊆ department validation | **E** | `budgets/budget.ts` — **definition-only** (`BUDGET_ENFORCEMENT_SCOPE`) |
| Serving execution limits | **E** | `serving/inventory.ts` |
| Budget request / approve (no self-change) | **E** | approval-service |
| Live metering, GPU reservation, kill-on-breach | **N** | Required for autonomous resource management |
| “Budget & Resources” as owning surface | **M** | Monitoring observes; ownership/name may map to Monitoring + budget services — **do not** invent a duplicate department if Monitoring already owns observation; clarify role split in C1.9A/F design |

### 4.3 Memory & Forgetting (C1.9F)

| Capability | Status | Location / note |
|---|---|---|
| Memory create/search/promote/consolidate | **E** | `memory-service.ts`, scopes agent/department/colony |
| Forgetting workflow + contamination lineage | **E** | evaluation-service forgetting APIs; tombstones |
| Training evidence taxonomy / retention | **E** | `training/evidence-service.ts` |
| Departmental **experience + performance** ledger for autonomy | **M** | Capability ledger + evidence exist; need explicit dept performance feed for adoption decisions |
| Weight unlearning | **N** (out of scope unless separately decided) | Forgetting does not unlearn weights today |

### 4.4 Evaluation and promotion (cross-cutting; critical for C1.9D)

| Capability | Status | Location / note |
|---|---|---|
| Evaluation service, gates, quarantine, rollback | **E** | `evaluation-service.ts`, `gate.ts` (`m6-gate-v1`) |
| Wilson / McNemar / paired stats | **E** | `evaluation/stats.ts`, `paired.ts` |
| C1.8A calculator suite | **E** | Complement to algebra |
| C1.8D.1 SymPy grader + locked ACL | **E** | Python + `evaluation/c18d1/access.ts` |
| Claim verification (no LLM consensus) | **E** | `claim-verification-service.ts` |
| **Adoption set** (separate from locked + from iterative train data) | **N** | Must define split + ACL before C1.9D auto-adopt |
| Periodic locked audit + refresh schedule | **N** | Locked gen exists; schedule + audit runner missing |
| Track-record promotion rule (N confirmed audits) | **N** | Protected rule store |
| Admin approval until track-record met | **M** | Training promote already experimental / human-gated — extend, don’t fork |
| Statistical eval noise-floor gate (if vLLM primary) | **N** / proposed | Optional C1.8D follow-on; reuse `stats.ts` patterns |

### 4.5 Autonomous engineering (C1.9B)

| Capability | Status | Location / note |
|---|---|---|
| Training sandbox (Docker, no net, no GPU, RO root) | **E** | `training-sandbox.ts`, C1.8C |
| Patch allowlist + disposable workspace | **E** | `patch-apply.ts`, `training-code-patch.ts` |
| Experimental route rollback | **E** | evaluation rollback path |
| Dedicated serving activation / digest gate | **E** | `serving/activation.ts`, M12 |
| General **code** engineering workspace (tests, review, staged deploy of colony services) | **N** | Beyond training-patch allowlist |
| Independent review agent / checklist gate | **N** | |
| Low-risk auto-deploy classifier (protected) | **N** | |
| Production rollback for colony services | **M** / **N** | Partial for experimental routes only |

### 4.6 Autonomous model acquisition (C1.9E)

| Capability | Status | Location / note |
|---|---|---|
| Model registry (register/version/status) | **E** | `model-service.ts` |
| HF revision pins for Math eval | **E** | `c18d1/pinned_revisions.json` |
| License / SPDX enforcement on acquire | **N** | Metadata strings only today |
| Verified-source download + format allowlist | **N** | |
| Sandbox test of acquired weights (no untrusted repo code exec) | **M** | Reuse sandbox; add acquisition workflow |
| Resource quotas on acquisition | **M** | Tie to budget services |
| Escalation path for exceptional acquires | **N** | |

### 4.7 Autonomous learning / training / adoption (C1.9D)

| Capability | Status | Location / note |
|---|---|---|
| Training propose / approve / execute / evaluate / promote | **E** | `training-service.ts` (experimental promote) |
| PEFT CUDA train/eval | **E** | `peft_lora_*.py`, Phase 0 |
| Department learning spec / workflow | **E** / **M** | C1.8B/C — validation + sandbox dry-run; no live Math cycle |
| Learning cycles observe→train→eval→assign | **E** | `learning-service.ts`; production model row isolated |
| Matched base/adapter Math eval (same prompts/seeds/backend) | **M** | HF `adapterPath` exists; vLLM LoRA + statistical improvement gate incomplete |
| Auto-adopt on verified improvement without routine admin | **N** | Blocked until Math cycle + adoption set + track-record |
| Production Ollama adapter swap | **N** | Explicitly out of C1.8D; gated in C1.9D |

### 4.8 Communication (C1.9C)

| Capability | Status | Location / note |
|---|---|---|
| IACP messaging + RabbitMQ | **E** | `message-service.ts`, `packages/messaging` |
| Department dialogue (2-party) | **E** | `dialogue-service.ts`, C1 autonomy report |
| Voluntary initiation by departments | **E** / **M** | Exists; expand multi-party invite (noted unfinished in C1 report) |
| Autonomy enable/pause/CEO cycles | **E** | `autonomy/*` |
| **Persistent live admin channel** (observe + participate) | **N** | Audit/health exist; no live tap of dept channels |
| Dialogue → Memory only via Memory & Forgetting | **E** | Current policy: dialogue does not auto-write memory |

### 4.9 Auth and enforcement boundary

| Capability | Status | Location / note |
|---|---|---|
| Dev Bearer = principal UUID | **M** | Non-dev rejects; production auth hardening needed before strong autonomy |
| Protections outside writable colony env | **N** | Critical for protected-path policy (host/CI/admin plane vs agent workspace) |

---

## 5. Suggested reuse map (avoid duplicate systems)

| Need | Reuse | Do not create |
|---|---|---|
| Org structure | Existing 13 seeded departments + department-service | Second org registry |
| Messaging | IACP + dialogue-service | Parallel chat bus |
| Memory | memory-service + forgetting workflow | Side memory DB for “experience” without linking |
| Eval / promote | evaluation-service + c18d1 grader/ACL | Department-owned graders for locked data |
| Stats for adoption | `evaluation/stats.ts` | Ad-hoc significance claims |
| Sandbox | C1.8C training-sandbox | Unrestricted shell for agents |
| Training | training-service + PEFT CUDA | Shadow trainer bypassing Evaluation |
| Budgets | contracts budget schemas + approval path | Soft-only limits with no enforcement story |
| Model identity | model-service + HF pins | Unpinned “latest” pulls |

---

## 6. Execution order (binding)

```
C1.8D remaining GPU acceptance (A/B/C)
        │
        ├──────────────────────────────┐
        ▼                              ▼
   C1.9A Protected infra          First Math training cycle
   C1.9B Engineering                    │
   C1.9C Live admin channel             ├── improvement OR failure documented
   C1.9E Model acquisition (careful)    │
   C1.9F Budget live + Memory perf      ▼
                                   C1.9D Autonomous train/adopt
                                        │
                                        ▼
                              Track-record rule → reduced admin
                              (rule protected; locked = audit only)
```

---

## 7. Exit criteria to begin implementation

| Gate | Required evidence |
|---|---|
| Start **C1.9A/B/C/E/F** | This document reviewed; C1.8D Stage A/B/C acceptance recorded (outcome may be fail-with-evidence) |
| Start **C1.9D** | Math cycle report with improvement **or** failure cause; adoption-set design written; locked-audit schedule drafted |
| Any auto-promote | Track-record rule specified as protected config; admin still required until N met |

---

## 8. Non-goals for early C1.9 slices

- Do not weaken C1.8D mathematical grading or open locked items to Math/WO.
- Do not auto-promote adapters to production Ollama in A–C.
- Do not execute untrusted third-party repo code during model acquisition.
- Do not overwrite Gate v2/v3 or Phase 0 historical reports.
- Do not implement C1.9 code in the same change set as this architecture document.

---

## 9. Document control

| Field | Value |
|---|---|
| Decision | Adopt §1 as C1.9 target architecture |
| Implementation | **Deferred** until §7 gates |
| Supersedes | None (no prior C1.9 docs) |
| Related | `C1_8D_1_*`, `C1_8D_PHASE0_*`, `C1_8B_*`, `C1_8C_*`, `C1_AUTONOMOUS_COLONY_REPORT.md`, M8–M12 |
