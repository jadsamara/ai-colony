#!/usr/bin/env python3
"""Exact/canonical duplicate detection and structural overlap audits."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def exact_duplicate_digests(items: list[dict[str, Any]]) -> list[str]:
    counts: dict[str, int] = defaultdict(int)
    for item in items:
        counts[item["contentDigest"]] += 1
    return sorted(digest for digest, count in counts.items() if count > 1)


def exact_prompt_collisions(items: list[dict[str, Any]]) -> list[str]:
    counts: dict[str, int] = defaultdict(int)
    for item in items:
        counts[item["prompt"]] += 1
    return sorted(prompt for prompt, count in counts.items() if count > 1)


def cross_split_leakage(dev: list[dict[str, Any]], locked: list[dict[str, Any]]) -> dict[str, Any]:
    dev_digests = {item["contentDigest"] for item in dev}
    locked_digests = {item["contentDigest"] for item in locked}
    shared = sorted(dev_digests & locked_digests)
    dev_prompts = {item["prompt"] for item in dev}
    locked_prompts = {item["prompt"] for item in locked}
    shared_prompts = sorted(dev_prompts & locked_prompts)
    return {
        "sharedContentDigests": shared,
        "sharedPrompts": shared_prompts,
        "ok": len(shared) == 0 and len(shared_prompts) == 0,
    }


def structural_family_separation(id_items: list[dict[str, Any]], ood_items: list[dict[str, Any]]) -> dict[str, Any]:
    id_families = {item["family"] for item in id_items}
    ood_families = {item["family"] for item in ood_items}
    overlap = sorted(id_families & ood_families)
    return {
        "idFamilies": sorted(id_families),
        "oodFamilies": sorted(ood_families),
        "overlappingFamilies": overlap,
        "ok": len(overlap) == 0,
        "structuralNote": (
            "OOD families must differ in algebraic structure (trig / Diophantine / piecewise), "
            "not merely random seed."
        ),
    }


def audit_paths(*, dev_glob: str, locked_glob: str, root: Path) -> dict[str, Any]:
    dev_files = sorted(root.glob(dev_glob))
    locked_files = sorted(root.glob(locked_glob))
    dev_items = [row for path in dev_files for row in load_jsonl(path)]
    locked_items = [row for path in locked_files for row in load_jsonl(path)]
    report = {
        "devExactDuplicateDigests": exact_duplicate_digests(dev_items),
        "lockedExactDuplicateDigests": exact_duplicate_digests(locked_items),
        "devPromptCollisions": len(exact_prompt_collisions(dev_items)),
        "lockedPromptCollisions": len(exact_prompt_collisions(locked_items)),
        "crossSplit": cross_split_leakage(dev_items, locked_items),
        "familySeparation": structural_family_separation(
            [i for i in locked_items if i.get("distribution") == "id"],
            [i for i in locked_items if i.get("distribution") == "ood"],
        ),
    }
    report["ok"] = (
        not report["devExactDuplicateDigests"]
        and not report["lockedExactDuplicateDigests"]
        and report["devPromptCollisions"] == 0
        and report["lockedPromptCollisions"] == 0
        and report["crossSplit"]["ok"]
        and report["familySeparation"]["ok"]
    )
    return report
