# C1.8D — Gemma smoke status

**Status:** Smoke **passed** on the GPU VM (operator-reported). Full 307-case audit is prepared but **not executed**.

## Smoke results (BF16, pinned revision `005ad340…`)

| Metric | Value |
|---|---|
| Mathematical agreement | **12/12** |
| Parseable JSON | **12/12** |
| Mean latency | **2,215 ms** |
| Startup | **74 s** |
| GPU memory | **~80.6 GB** |
| Shutdown | Clean |

## Full audit gate

| Gate | State |
|---|---|
| 12-case smoke | **Passed** |
| CPU full-audit prepare | `./scripts/c18d1-full-blind-audit-prepare` |
| Full 307-case audit | **Blocked** until separate approval + `C18D1_LLM_AUDIT_CONFIRM=1` on GPU VM |
| Pilot / Stage B / training / promotion | **Blocked** |

## Smoke-calibrated runtime (serial, 307 cases)

- Generation ≈ 307 × 2.215 s ≈ **11.3 min**
- Plus ~74 s startup → **~12.5 min** total (~**0.21 GPU-hours**)
- Reuse HF cache; do not redownload pinned weights

## VM execute (only after approval)

```bash
export C18D1_LLM_AUDIT_CONFIRM=1
export C18D1_BLIND_PACKETS=/path/to/blind-packets.jsonl
export C18D1_OUT=~/ai-colony/tmp/c18d1/gemma-full-audit-$(date +%Y%m%d-%H%M%S)
./scripts/c18d1-gpu-gemma-full-audit
```
