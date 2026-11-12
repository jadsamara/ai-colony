#!/usr/bin/env python3
"""CUDA / Blackwell-oriented LoRA trainer entrypoint (dry-run only in C1.8C).

This script is intentionally separate from the MLX Apple Silicon trainers.
It validates a reproducible job manifest, refuses weight downloads and GPU
execution in this milestone, and writes structured dry-run metrics.

Real torch/transformers/peft/trl training is deferred until an isolated CUDA
environment is verified. Dry-run uses the Python standard library only so it
can smoke-test inside a network-isolated container without pulling models.
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

from common_cuda import (
    TrainerError,
    assert_safe_env,
    assert_training_config,
    fail,
    load_job,
    write_json,
    write_manifest,
)


def run_dry_run(job: dict) -> dict:
    assert_safe_env()
    assert_training_config(job)
    if job.get("dryRun") is not True:
        fail("DRY_RUN_REQUIRED", "C1.8C only permits dryRun=true execution")

    output = Path(str(job["outputDir"])).resolve()
    output.mkdir(parents=True, exist_ok=True)
    dataset_path = job.get("datasetPath")
    if dataset_path:
        data = Path(str(dataset_path)).resolve()
        if not data.exists():
            fail("DATASET_MISSING", f"Dataset path missing: {data}")

    started = time.time()
    manifest = write_manifest(
        job,
        output,
        extra={
            "mode": "dry_run",
            "executedTrainingSteps": 0,
            "weightsLoaded": False,
        },
    )
    metrics = {
        "status": "dry_run_ok",
        "trainLoss": None,
        "validationLoss": None,
        "stepsPlanned": int(job.get("steps") or 0),
        "stepsExecuted": 0,
        "durationMs": int((time.time() - started) * 1000),
        "peakMemoryBytes": None,
        "manifest": manifest,
    }
    write_json(output / "metrics.json", metrics)
    write_json(
        output / "result.json",
        {
            "ok": True,
            "dryRun": True,
            "cancelled": False,
            "artifactPath": None,
            "format": None,
            "durationMs": metrics["durationMs"],
            "peakMemoryBytes": None,
            "trainLoss": None,
            "validationLoss": None,
            "metrics": [],
            "message": "Dry-run validated configuration; GPU training not executed",
        },
    )
    return metrics


def _write_failure(job_path: str | None, payload: dict) -> None:
    if not job_path:
        return
    try:
        raw = json.loads(Path(job_path).read_text(encoding="utf-8"))
        out_dir = Path(str(raw.get("outputDir") or "/tmp")).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        write_json(out_dir / "result.json", payload)
    except Exception:
        return


def main() -> None:
    job_path = sys.argv[2] if len(sys.argv) >= 3 else None
    try:
        job = load_job(sys.argv)
        run_dry_run(job)
    except TrainerError as error:
        _write_failure(job_path, {"ok": False, "code": error.code, "message": str(error)})
        sys.stderr.write(f"{error.code}: {error}\n")
        raise SystemExit(2)
    except Exception:
        traceback.print_exc()
        _write_failure(job_path, {"ok": False, "code": "INTERNAL", "message": "trainer crashed"})
        raise SystemExit(1)


if __name__ == "__main__":
    main()
