#!/usr/bin/env python3
"""Shared helpers for the CUDA / Blackwell LoRA trainer (stdlib-only dry-run path).

Full GPU training imports (torch / transformers / peft / trl) are deferred until a
later milestone that installs a verified CUDA stack. This module never contacts
Ollama and never writes under production model volumes.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


SUPPORTED_BASE_ALIASES = {"qwen3:8b", "Qwen/Qwen3-8B"}
FORBIDDEN_ENV_MARKERS = (
    "DATABASE_URL",
    "POSTGRES_",
    "RABBITMQ_",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OLLAMA_",
    "AWS_",
    "GCP_",
)


class TrainerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def fail(code: str, message: str) -> None:
    raise TrainerError(code, message)


def load_job(argv: list[str]) -> dict[str, Any]:
    if len(argv) < 3 or argv[1] != "--job":
        fail("INVALID_ARGS", "Usage: train_lora_cuda.py --job <path>")
    path = Path(argv[2]).resolve()
    if not path.is_file():
        fail("JOB_MISSING", f"Job file not found: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        fail("JOB_INVALID", "Job payload must be a JSON object")
    return payload


def assert_safe_env() -> None:
    for key in os.environ:
        upper = key.upper()
        for marker in FORBIDDEN_ENV_MARKERS:
            if upper.startswith(marker) or marker.rstrip("_") == upper:
                fail("SECRET_ENV", f"Forbidden environment variable present: {key}")


def assert_training_config(job: dict[str, Any]) -> None:
    backend = job.get("backend")
    if backend not in {"cuda-lora", "cuda"}:
        fail("BACKEND", f"Unsupported backend {backend!r}; expected cuda-lora")
    alias = str(job.get("baseModelAlias") or "")
    if alias not in SUPPORTED_BASE_ALIASES:
        fail("BASE_MODEL", f"Unsupported base model alias {alias!r}")
    if job.get("downloadWeights") is True:
        fail("DOWNLOAD_FORBIDDEN", "Weight downloads are disabled in this milestone")
    if job.get("useGpu") is True and job.get("dryRun") is not True:
        fail("GPU_FORBIDDEN", "GPU training is disabled until a later milestone")
    seed = job.get("seed")
    if seed is None or int(seed) < 0:
        fail("SEED", "A non-negative deterministic seed is required")
    rank = int(job.get("loraRank") or job.get("rank") or 8)
    if rank < 1 or rank > 256:
        fail("LORA_RANK", "LoRA rank out of range")
    lr = float(job.get("learningRate") or 0)
    if lr <= 0 or lr > 1e-2:
        fail("LEARNING_RATE", "Learning rate out of local safety budget")
    steps = int(job.get("steps") or 0)
    if steps < 0 or steps > 200:
        fail("STEPS", "Step count out of local safety budget")
    output = Path(str(job.get("outputDir") or "")).resolve()
    if "ollama" in str(output).lower():
        fail("OUTPUT_PATH", "Output directory must not target Ollama volumes")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(job: dict[str, Any], output: Path, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    manifest = {
        "backend": "cuda-lora",
        "baseModelAlias": job.get("baseModelAlias"),
        "datasetId": job.get("datasetId"),
        "datasetContentHash": job.get("datasetContentHash"),
        "seed": job.get("seed"),
        "loraRank": int(job.get("loraRank") or job.get("rank") or 8),
        "learningRate": job.get("learningRate"),
        "steps": job.get("steps"),
        "dryRun": bool(job.get("dryRun")),
        "downloadWeights": False,
        "useGpu": False,
        "libraries": {
            "torch": "deferred",
            "transformers": "deferred",
            "peft": "deferred",
            "trl": "deferred",
        },
        "note": "Compatibility targets NVIDIA Blackwell via PyTorch/PEFT/TRL once CUDA stack is pinned.",
    }
    if extra:
        manifest.update(extra)
    write_json(output / "config-manifest.json", manifest)
    return manifest

