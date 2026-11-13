#!/usr/bin/env python3
"""Build versioned C1.8D.1 algebra datasets and manifests."""

from __future__ import annotations

import json
from pathlib import Path

from generators import (
    BENCHMARK_VERSION,
    ID_FAMILIES,
    OOD_FAMILIES,
    generate_split,
    manifest_for,
    write_jsonl,
)
from overlap_audit import audit_paths

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "datasets"


def _write_manifest(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build() -> dict:
    # Minimum sizes from the milestone brief.
    dev = generate_split(
        stream="dev",
        families=ID_FAMILIES,
        per_family=50,
        distribution="id",
        split="development",
    )
    locked_id = generate_split(
        stream="locked_id",
        families=ID_FAMILIES,
        per_family=100,
        distribution="id",
        split="locked_id",
    )
    locked_ood = generate_split(
        stream="locked_ood",
        families=OOD_FAMILIES,
        per_family=100,
        distribution="ood",
        split="locked_ood",
    )
    # Regression slice: format / thinking / basic math / instruction following.
    regression = generate_split(
        stream="regression",
        families=["linear_equations", "symbolic_simplification", "quadratic_equations"],
        per_family=40,
        distribution="regression",
        split="regression",
    )

    write_jsonl(DATA / "dev" / "id_dev.jsonl", dev)
    write_jsonl(DATA / "locked" / "id_locked.jsonl", locked_id)
    write_jsonl(DATA / "locked" / "ood_locked.jsonl", locked_ood)
    write_jsonl(DATA / "regression" / "regression.jsonl", regression)

    manifests = {
        "benchmarkVersion": BENCHMARK_VERSION,
        "difficultyFrozen": True,
        "difficultyBasis": "development_structural_tiers_only",
        "splits": {
            "development": manifest_for(dev, name="id_dev"),
            "locked_id": manifest_for(locked_id, name="id_locked"),
            "locked_ood": manifest_for(locked_ood, name="ood_locked"),
            "regression": manifest_for(regression, name="regression"),
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
            "locked_id": len(locked_id),
            "locked_ood": len(locked_ood),
            "regression": len(regression),
        },
    }
    _write_manifest(DATA / "manifests" / "benchmark_manifest.json", manifests)

    audit = audit_paths(
        root=DATA,
        dev_glob="dev/*.jsonl",
        locked_glob="locked/*.jsonl",
    )
    _write_manifest(DATA / "manifests" / "overlap_audit.json", audit)
    if not audit["ok"]:
        raise SystemExit(f"Overlap audit failed: {json.dumps(audit, indent=2)}")

    # Public aggregate-only stub for learning agents (no item-level fields).
    _write_manifest(
        DATA / "manifests" / "public_aggregate_stub.json",
        {
            "benchmarkVersion": BENCHMARK_VERSION,
            "status": "datasets_generated_baselines_pending",
            "counts": manifests["counts"],
            "note": "Item-level locked contents withheld. Evaluation-owned.",
        },
    )
    return {"manifest": manifests, "audit": audit}


if __name__ == "__main__":
    result = build()
    print(json.dumps({"ok": True, "counts": result["manifest"]["counts"], "auditOk": result["audit"]["ok"]}, indent=2))
