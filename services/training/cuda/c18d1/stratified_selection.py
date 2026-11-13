#!/usr/bin/env python3
"""Stratified Stage A pilot selection from DEVELOPMENT items only.

Covers all 10 ID algebra families × {easy, moderate, hard}.
Never reads locked ID/OOD paths.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path
from typing import Any

from access_control import DEV_DIR
from generators import ID_FAMILIES, prompt_leaks_split_identity

DIFFICULTIES = ("easy", "moderate", "hard")
SELECTION_VERSION = "c18d1-stratified-pilot-v1"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def assert_development_only(path: Path) -> None:
    resolved = path.resolve()
    parts = {p.lower() for p in resolved.parts}
    if "locked" in parts:
        raise PermissionError(f"Stratified pilot refuses locked paths: {resolved}")
    # Prefer under datasets/dev
    if "dev" not in parts and "development" not in parts:
        # Allow explicit override only if path is under DEV_DIR
        if not str(resolved).startswith(str(DEV_DIR.resolve())):
            raise PermissionError(
                f"Stratified pilot requires development dataset under {DEV_DIR}, got {resolved}",
            )


def dataset_content_hash(items: list[dict[str, Any]]) -> str:
    digests = sorted(str(item.get("contentDigest") or item.get("id")) for item in items)
    return hashlib.sha256(json.dumps(digests, sort_keys=True).encode()).hexdigest()


def verify_item_provenance(item: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    split = item.get("split")
    if split not in {"development", "dev"}:
        issues.append("unexpected_split")
    if item.get("distribution") not in {"id", "development"}:
        issues.append("unexpected_distribution")
    if item.get("family") not in ID_FAMILIES:
        issues.append("unknown_family")
    if item.get("difficulty") not in DIFFICULTIES:
        issues.append("unknown_difficulty")
    if prompt_leaks_split_identity(str(item.get("prompt") or "")):
        issues.append("prompt_leaks_split_identity")
    if "Instance:" in str(item.get("prompt") or ""):
        issues.append("instance_tag")
    prov = item.get("provenance") or {}
    stream = str(prov.get("stream") or "")
    if "locked" in stream.lower():
        issues.append("locked_provenance_stream")
    elif stream and stream not in {"development", "dev"}:
        issues.append("unexpected_provenance_stream")
    return issues


def stratified_select(
    items: list[dict[str, Any]],
    *,
    per_cell: int = 1,
    seed: int = 18,
    families: tuple[str, ...] | list[str] = ID_FAMILIES,
) -> dict[str, Any]:
    """Select up to ``per_cell`` items for each family × difficulty cell.

    Sampling is deterministic given ``seed``. Cells with fewer than ``per_cell``
    available items take all available and record a shortfall.
    """
    by_cell: dict[tuple[str, str], list[dict[str, Any]]] = {}
    provenance_issues: list[dict[str, Any]] = []
    for item in items:
        issues = verify_item_provenance(item)
        if issues:
            provenance_issues.append({"itemId": item.get("id"), "issues": issues})
            continue
        key = (str(item["family"]), str(item["difficulty"]))
        by_cell.setdefault(key, []).append(item)

    selected: list[dict[str, Any]] = []
    cell_report: list[dict[str, Any]] = []
    shortfalls: list[dict[str, Any]] = []
    rng = random.Random(int(seed))

    for family in families:
        for difficulty in DIFFICULTIES:
            pool = list(by_cell.get((family, difficulty), []))
            pool.sort(key=lambda row: str(row["id"]))
            rng.shuffle(pool)
            take = pool[: int(per_cell)]
            selected.extend(take)
            cell_report.append(
                {
                    "family": family,
                    "difficulty": difficulty,
                    "available": len(pool),
                    "selected": len(take),
                    "itemIds": [row["id"] for row in take],
                },
            )
            if len(take) < int(per_cell):
                shortfalls.append(
                    {
                        "family": family,
                        "difficulty": difficulty,
                        "requested": int(per_cell),
                        "available": len(pool),
                    },
                )

    selected.sort(key=lambda row: (row["family"], row["difficulty"], row["id"]))
    families_covered = sorted({row["family"] for row in selected})
    difficulties_covered = sorted({row["difficulty"] for row in selected})
    ok = (
        set(families_covered) == set(families)
        and set(difficulties_covered) == set(DIFFICULTIES)
        and len(provenance_issues) == 0
        and all(cell["selected"] >= 1 for cell in cell_report)
    )
    return {
        "ok": ok,
        "selectionVersion": SELECTION_VERSION,
        "seed": int(seed),
        "perCell": int(per_cell),
        "itemCount": len(selected),
        "expectedCells": len(families) * len(DIFFICULTIES),
        "families": list(families),
        "difficulties": list(DIFFICULTIES),
        "familiesCovered": families_covered,
        "difficultiesCovered": difficulties_covered,
        "allFamiliesCovered": set(families_covered) == set(families),
        "allDifficultiesCovered": set(difficulties_covered) == set(DIFFICULTIES),
        "cells": cell_report,
        "shortfalls": shortfalls,
        "provenanceIssues": provenance_issues,
        "contentHash": dataset_content_hash(selected),
        "access": "development_only",
        "lockedAccess": False,
        "items": selected,
    }


def write_selection(result: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    items = result["items"]
    jsonl_path = output_dir / "stratified_pilot.jsonl"
    with jsonl_path.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, sort_keys=True) + "\n")
    manifest = {key: value for key, value in result.items() if key != "items"}
    manifest["datasetPath"] = str(jsonl_path.resolve())
    _write_json(output_dir / "stratified_selection_manifest.json", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        type=Path,
        default=DEV_DIR / "id_dev.jsonl",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--per-cell", type=int, default=1)
    parser.add_argument("--seed", type=int, default=18)
    args = parser.parse_args()
    assert_development_only(args.dataset)
    items = _load_jsonl(args.dataset)
    result = stratified_select(items, per_cell=args.per_cell, seed=args.seed)
    manifest = write_selection(result, args.output_dir)
    print(json.dumps({"ok": manifest["ok"], "itemCount": manifest["itemCount"], "contentHash": manifest["contentHash"], "outputDir": str(args.output_dir)}, indent=2))
    if not manifest["ok"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
