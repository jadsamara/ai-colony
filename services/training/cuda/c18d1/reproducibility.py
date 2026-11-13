#!/usr/bin/env python3
"""Reproducibility manifest for C1.8D.1 evaluation runs."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from generation_utils import (
    BATCHING_POLICY,
    EVAL_IMPLEMENTATION_VERSION,
    OFFICIAL_BACKEND,
    PROMPT_INSTRUCTION_VERSION,
)
from answer_parser import GRADER_VERSION


MANIFEST_VERSION = "c18d1-repro-manifest-v1"


def file_sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_reproducibility_manifest(
    *,
    pinned: dict[str, Any],
    decoding: dict[str, Any],
    batch_size: int,
    dataset_path: str | Path,
    dataset_content_hash: str | None,
    backend: str,
    template_fingerprint: str | None,
    condition_id: str,
    seed: int,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    path = Path(dataset_path)
    return {
        "manifestVersion": MANIFEST_VERSION,
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "graderVersion": GRADER_VERSION,
        "promptInstructionVersion": PROMPT_INSTRUCTION_VERSION,
        "officialBackend": OFFICIAL_BACKEND,
        "backend": backend,
        "backendIsOfficial": backend == OFFICIAL_BACKEND,
        "modelId": pinned.get("modelId"),
        "tokenizerId": pinned.get("tokenizerId"),
        "modelRevision": pinned.get("modelRevision"),
        "tokenizerRevision": pinned.get("tokenizerRevision"),
        "templateFingerprint": template_fingerprint,
        "conditionId": condition_id,
        "decoding": decoding,
        "batchSize": int(batch_size),
        "batchingPolicy": BATCHING_POLICY,
        "seed": int(seed),
        "datasetPath": str(path),
        "datasetSha256": file_sha256(path) if path.exists() else None,
        "datasetContentHash": dataset_content_hash,
        "extra": extra or {},
    }
