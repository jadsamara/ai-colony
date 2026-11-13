#!/usr/bin/env python3
"""Build in-repo C1.8D.1 public splits (development + regression) and manifests.

Locked splits are NOT generated here — see build_locked_datasets.py (external seeds,
output directory outside the repo).
"""

from __future__ import annotations

import json
from pathlib import Path

from generators import (
    BENCHMARK_VERSION,
    GENERATOR_VERSION,
    ID_FAMILIES,
    PUBLIC_SEEDS,
    RETIRED_LOCKED_BENCHMARK_VERSION,
    generate_split,
    manifest_for,
    prompt_leaks_split_identity,
    write_jsonl,
)
from overlap_audit import audit_paths, exact_duplicate_digests, exact_prompt_collisions

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "datasets"


def _write_manifest(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build() -> dict:
    dev = generate_split(
        stream="dev",
        stream_seed=PUBLIC_SEEDS["dev"],
        families=ID_FAMILIES,
        per_family=50,
        distribution="id",
        split="development",
        record_public_seed=True,
    )
    regression = generate_split(
        stream="regression",
        stream_seed=PUBLIC_SEEDS["regression"],
        families=["linear_equations", "symbolic_simplification", "quadratic_equations"],
        per_family=40,
        distribution="regression",
        split="regression",
        record_public_seed=True,
    )

    for item in [*dev, *regression]:
        if prompt_leaks_split_identity(item.prompt):
            raise SystemExit(f"Prompt leaks split identity: {item.id}")

    write_jsonl(DATA / "dev" / "id_dev.jsonl", dev)
    write_jsonl(DATA / "regression" / "regression.jsonl", regression)

    # Locked v1 retired; v2 locked manifests are written on the Evaluation host only.
    manifests = {
        "benchmarkVersion": BENCHMARK_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "difficultyFrozen": True,
        "difficultyBasis": "development_structural_tiers_only",
        "retiredLocked": {
            "benchmarkVersion": RETIRED_LOCKED_BENCHMARK_VERSION,
            "status": "retired",
            "reason": (
                "Locked JSONL for c18d1-algebra-v1 was tracked in git (answers + "
                "provenance.streamSeed). Never evaluated. Must never be used for "
                "evaluation or training."
            ),
            "replacement": "c18d1-algebra-v2 locked splits (external seeds; out-of-repo data)",
        },
        "splits": {
            "development": manifest_for(dev, name="id_dev"),
            "regression": manifest_for(regression, name="regression"),
            "locked_id": {
                "status": "external_only",
                "note": "Generate with build_locked_datasets.py; commit manifests only.",
            },
            "locked_ood": {
                "status": "external_only",
                "note": "Generate with build_locked_datasets.py; commit manifests only.",
            },
        },
        "minimums": {
            "devPerIdFamily": 50,
            "lockedPerIdFamily": 100,
            "lockedPerOodFamily": 100,
            "idFamilies": 10,
            "oodFamilies": 3,
        },
        "oodStructuralDistinctions": {
            "trigonometric_equations": "Uses trig equations absent from ID families.",
            "linear_diophantine": "Integer Diophantine constraints vs real closed-form algebra.",
            "piecewise_equations": "Piecewise branch structure absent from ID templates.",
        },
        "counts": {
            "development": len(dev),
            "regression": len(regression),
            "locked_id": None,
            "locked_ood": None,
        },
    }
    _write_manifest(DATA / "manifests" / "benchmark_manifest.json", manifests)

    # Deduplicate checks are per-file (dev and regression may share templates across streams
    # only if generators collide; require uniqueness within each file).
    dev_rows = [
        json.loads(line)
        for line in (DATA / "dev" / "id_dev.jsonl").read_text().splitlines()
        if line.strip()
    ]
    reg_rows = [
        json.loads(line)
        for line in (DATA / "regression" / "regression.jsonl").read_text().splitlines()
        if line.strip()
    ]
    audit = {
        "scope": "in_repo_public_splits_only",
        "devExactDuplicateDigests": exact_duplicate_digests(dev_rows),
        "regressionExactDuplicateDigests": exact_duplicate_digests(reg_rows),
        "devPromptCollisions": len(exact_prompt_collisions(dev_rows)),
        "regressionPromptCollisions": len(exact_prompt_collisions(reg_rows)),
        "ok": True,
    }
    audit["ok"] = (
        not audit["devExactDuplicateDigests"]
        and not audit["regressionExactDuplicateDigests"]
        and audit["devPromptCollisions"] == 0
        and audit["regressionPromptCollisions"] == 0
    )
    path_audit = audit_paths(root=DATA, dev_glob="dev/*.jsonl", locked_glob="locked/*.jsonl")
    audit["pathAudit"] = path_audit
    if path_audit["devExactDuplicateDigests"] or path_audit["devPromptCollisions"]:
        audit["ok"] = False
    _write_manifest(DATA / "manifests" / "overlap_audit.json", audit)
    if not audit["ok"]:
        raise SystemExit(f"Public-split overlap audit failed: {json.dumps(audit, indent=2)}")

    _write_manifest(
        DATA / "manifests" / "public_aggregate_stub.json",
        {
            "benchmarkVersion": BENCHMARK_VERSION,
            "status": "public_splits_ready_locked_external",
            "counts": {
                "development": len(dev),
                "regression": len(regression),
            },
            "note": (
                "Locked item-level contents are not in the repo. "
                "Evaluation generates them outside the repo with external seeds."
            ),
        },
    )
    _write_manifest(
        DATA / "manifests" / "RETIRED_LOCKED_V1.json",
        {
            "benchmarkVersion": RETIRED_LOCKED_BENCHMARK_VERSION,
            "status": "retired",
            "neverEvaluate": True,
            "neverTrain": True,
            "reason": (
                "services/training/cuda/c18d1/datasets/locked/*.jsonl were tracked in git, "
                "including expected answers and provenance.streamSeed. No locked evaluation "
                "had run. Retired rather than patched."
            ),
            "replacement": "c18d1-algebra-v2 locked splits via external seeds",
        },
    )
    return {"manifest": manifests, "audit": audit}


if __name__ == "__main__":
    result = build()
    print(json.dumps({"ok": True, "counts": result["manifest"]["counts"], "auditOk": result["audit"]["ok"]}, indent=2))
