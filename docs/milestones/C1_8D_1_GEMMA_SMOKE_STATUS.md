# C1.8D — Gemma smoke status

**Status:** Implementation ready; **GPU smoke not executed in this Cursor session.**

Cursor runs on a Mac without `nvidia-smi` / RTX PRO 6000 access (same constraint as prior C1.8D GPU steps). Actual download, BF16 serve, VRAM, latency, and 12-case judgments must be produced on the Debian GPU VM via:

```bash
./scripts/c18d1-gpu-gemma-smoke
```

Do not invent smoke metrics here. After the VM run, copy `gemma-smoke-report.json` for review.

| Gate | State |
|---|---|
| 12-case smoke | Pending operator VM execution |
| Full 307-case audit | **Blocked** until smoke review + separate approval |
| Pilot / Stage B / training / promotion | **Blocked** |
