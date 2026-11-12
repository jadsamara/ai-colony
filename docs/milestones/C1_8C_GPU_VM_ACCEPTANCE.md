# C1.8C — GPU VM Acceptance Test

## Status

| Check | Status |
|---|---|
| Local unit tests for the acceptance harness | Verified in CI/dev machine |
| TypeScript build | Verified in CI/dev machine |
| **GPU VM Docker sandbox acceptance** | **PENDING — run manually over SSH** |

Cursor runs on a local Mac and has **no access** to the Google Cloud GPU VM. Do not treat a green local test suite as GPU VM verification.

## One command (GPU VM)

After pushing/pulling the commit that adds this harness:

```bash
cd /path/to/ai-colony
git status   # confirm expected commit
./scripts/c18c-sandbox-acceptance
```

Equivalent:

```bash
pnpm accept:c18c:vm
# or, if the image is already built and you want fail-closed without rebuild:
pnpm accept:c18c -- --no-build
```

### What the command does

1. Builds `packages/contracts` + `packages/core` with `tsc -b` (thin prep for `tsx`).
2. Ensures Docker image `ai-colony-training-sandbox:c18c` exists (builds from `deploy/Dockerfile.training-sandbox` when missing).
3. Builds a **deterministic, approved** C1.8C experiment + allowlisted patch.
4. Runs `validateTrainingCodePatch` + `validateDepartmentLearningExperiment`.
5. Runs `executeTrainingCodeSandbox` with the **real** Docker runner (`--network=none`, read-only root, no GPU, no docker.socket).
6. Executes `py_compile` and `train_lora_cuda.py` dry-run inside the container.
7. Writes evidence under `tmp/c18c-acceptance/evidence/<experimentId>/`.
8. Writes `tmp/c18c-acceptance/acceptance-report.json`.
9. Confirms production allowlisted training files are unchanged and the disposable workspace was deleted.
10. **Fails closed** if Docker/image isolation cannot be established.

### What it refuses

- PostgreSQL / `DATABASE_URL` usage
- Ollama container or model changes
- Weight downloads
- GPU training (`useGpu=false`, `trainingLaunched=false`)

### Image build note

The first `docker build` may need network **once** to fetch `python:3.11-slim-bookworm`. That is operator image construction, not agent-code execution. The acceptance container run itself uses `--network none`.

## Artifacts to inspect on the VM

```bash
cat tmp/c18c-acceptance/acceptance-report.json
ls tmp/c18c-acceptance/evidence/00000000-0000-4000-8000-000000000c18/
```

Expect `ok: true`, `dockerIsolationVerified: true`, `productionRepoUnchanged: true`, `gpuUsed: false`, `databaseAccessed: false`.

## Local developer checks (not GPU VM verification)

```bash
pnpm exec vitest run --config vitest.unit.config.ts \
  tests/unit/c18c-acceptance.test.ts \
  tests/unit/training-sandbox.test.ts \
  tests/unit/department-learning.test.ts
pnpm exec tsc -b
```
