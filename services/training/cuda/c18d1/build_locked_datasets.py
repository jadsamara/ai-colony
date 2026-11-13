#!/usr/bin/env python3
"""Generate C1.8D.1 algebra v2 locked splits outside the repository.

Requires external seeds (C18D1_LOCKED_SEED_FILE or C18D1_LOCKED_SEED_ID/OOD).
Writes JSONL + item-level artifacts only under C18D1_LOCKED_DATA_DIR (outside repo).
Writes commit-safe manifests (counts, content hashes, generator version, seed hash)
into the repo manifests directory when C18D1_WRITE_REPO_MANIFESTS=1.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from generators import (
    BENCHMARK_VERSION,
    GENERATOR_VERSION,
    ID_FAMILIES,
    OOD_FAMILIES,
    generate_split,
    manifest_for,
    prompt_leaks_split_identity,
    write_jsonl,
)
from locked_seeds import LockedSeedError, load_locked_stream_seeds, require_locked_output_dir
from overlap_audit import cross_split_leakage, load_jsonl

ROOT = Path(__file__).resolve().parent
REPO_MANIFESTS = ROOT / "datasets" / "manifests"
REPO_DEV = ROOT / "datasets" / "dev" / "id_dev.jsonl"


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_locked() -> dict:
    seeds = load_locked_stream_seeds()
    out_root = require_locked_output_dir(
        os.environ.get("C18D1_LOCKED_DATA_DIR", "").strip()
        or (_raise_missing_outdir()),
    )
    out_root.mkdir(parents=True, exist_ok=True)

    locked_id = generate_split(
        stream="locked_id",
        stream_seed=int(seeds["locked_id"]),
        families=ID_FAMILIES,
        per_family=100,
        distribution="id",
        split="locked_id",
        seed_hash=seeds["seedHash"],
        record_public_seed=False,
    )
    locked_ood = generate_split(
        stream="locked_ood",
        stream_seed=int(seeds["locked_ood"]),
        families=OOD_FAMILIES,
        per_family=100,
        distribution="ood",
        split="locked_ood",
        seed_hash=seeds["seedHash"],
        record_public_seed=False,
    )

    for item in [*locked_id, *locked_ood]:
        if prompt_leaks_split_identity(item.prompt):
            raise SystemExit(f"Locked prompt leaks split identity: {item.id}")
        if "streamSeed" in item.provenance:
            raise SystemExit(f"Locked item must not record streamSeed: {item.id}")
        if item.provenance.get("seedHash") != seeds["seedHash"]:
            raise SystemExit(f"Locked item missing seedHash: {item.id}")

    id_path = out_root / "id_locked.jsonl"
    ood_path = out_root / "ood_locked.jsonl"
    write_jsonl(id_path, locked_id)
    write_jsonl(ood_path, locked_ood)

    # Results directory for later Stage C item-level artifacts (same restricted location).
    (out_root / "results").mkdir(exist_ok=True)

    id_manifest = manifest_for(locked_id, name="id_locked")
    ood_manifest = manifest_for(locked_ood, name="ood_locked")
    for family in ID_FAMILIES:
        id_manifest.setdefault("countsPerFamily", {})[family] = sum(
            1 for item in locked_id if item.family == family
        )
    for family in OOD_FAMILIES:
        ood_manifest.setdefault("countsPerFamily", {})[family] = sum(
            1 for item in locked_ood if item.family == family
        )

    locked_manifest = {
        "benchmarkVersion": BENCHMARK_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "seedHash": seeds["seedHash"],
        "seedSourceKind": seeds["sourceKind"],
        "dataDir": str(out_root),
        "splits": {
            "locked_id": id_manifest,
            "locked_ood": ood_manifest,
        },
        "counts": {
            "locked_id": len(locked_id),
            "locked_ood": len(locked_ood),
        },
        "access": {
            "itemLevel": "evaluation_only_outside_repo",
            "rawSeedsRecordedInItems": False,
        },
    }
    _write_json(out_root / "locked_manifest.json", locked_manifest)

    if REPO_DEV.exists():
        leakage = cross_split_leakage(load_jsonl(REPO_DEV), load_jsonl(id_path))
        locked_manifest["devOverlapAudit"] = leakage
        if not leakage["ok"]:
            raise SystemExit(f"Locked ID overlaps development prompts/digests: {leakage}")

    # Commit-safe copies: no raw seeds, no item text.
    commit_safe = {
        "benchmarkVersion": BENCHMARK_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "seedHash": seeds["seedHash"],
        "seedSourceKind": seeds["sourceKind"],
        "counts": locked_manifest["counts"],
        "countsPerFamily": {
            "locked_id": id_manifest.get("countsPerFamily"),
            "locked_ood": ood_manifest.get("countsPerFamily"),
        },
        "contentHashes": {
            "locked_id": id_manifest["contentHash"],
            "locked_ood": ood_manifest["contentHash"],
        },
        "note": (
            "Item-level locked JSONL lives outside the repo under Evaluation control. "
            "This manifest is safe to commit."
        ),
    }
    _write_json(out_root / "locked_manifest_commit_safe.json", commit_safe)

    if os.environ.get("C18D1_WRITE_REPO_MANIFESTS", "").strip() == "1":
        _write_json(REPO_MANIFESTS / "locked_v2_manifest.json", commit_safe)

    # Drop raw seeds from returned summary.
    return {
        "ok": True,
        "seedHash": seeds["seedHash"],
        "counts": locked_manifest["counts"],
        "dataDir": str(out_root),
        "commitSafeManifest": str(out_root / "locked_manifest_commit_safe.json"),
    }


def _raise_missing_outdir() -> str:
    raise LockedSeedError(
        "Set C18D1_LOCKED_DATA_DIR to an absolute path outside the repository "
        "(e.g. /var/lib/ai-colony/evaluation/c18d1-locked-v2).",
    )


if __name__ == "__main__":
    try:
        result = build_locked()
    except LockedSeedError as exc:
        raise SystemExit(f"LOCKED_SEED_ERROR: {exc}") from exc
    print(json.dumps(result, indent=2))
