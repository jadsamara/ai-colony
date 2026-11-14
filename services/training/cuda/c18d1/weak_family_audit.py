#!/usr/bin/env python3
"""Weak-family wrong/invalid audit from existing C1.8D evaluation artifacts.

v2: classifications are **independent** of the grader under audit. A row is a
genuine mathematical error only when an independently extracted candidate is
successfully compared and proven unequal to the expected value. Historical
``outcome=wrong`` alone never implies genuine_math_error.

Confirmed grader misses require a versioned grader bump before Stage B.
Does not access locked Stage C data. Does not invent model outputs.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

from answer_parser import GRADER_VERSION
from exact_repr import correct_expected, strip_correction_metadata
from family_diagnostics import WEAK_FAMILIES, _load_results, resolve_condition_artifact
from independent_check import classify_independently

AUDIT_VERSION = "c18d1-weak-family-audit-v2"
AUDIT_VERSION_PREVIOUS = "c18d1-weak-family-audit-v1"


def _load_expected_index(dataset_path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for line in dataset_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        out[str(item["id"])] = item
    return out


def classify_failure(
    row: dict[str, Any],
    expected: dict[str, Any],
    *,
    enable_thinking: bool,
    prompt: str | None = None,
) -> dict[str, Any]:
    """Independent classification (does not trust grader wrong → genuine error)."""
    expected_corr = strip_correction_metadata(correct_expected(expected, prompt=prompt))
    return classify_independently(
        row,
        expected_corr,
        enable_thinking=enable_thinking,
        prompt=prompt,
    )


def sample_family_failures(
    results: list[dict[str, Any]],
    *,
    family: str,
    expected_index: dict[str, dict[str, Any]],
    enable_thinking: bool,
    sample_size: int,
    seed: int,
) -> list[dict[str, Any]]:
    pool = [
        row
        for row in results
        if str(row.get("family")) == family
        and str(row.get("outcome")) in {"wrong", "invalid", "truncated", "grader_error"}
    ]
    rng = random.Random(seed + abs(hash(family)) % 10_000)
    rng.shuffle(pool)
    chosen = pool[:sample_size]
    audited: list[dict[str, Any]] = []
    for row in chosen:
        item = expected_index.get(str(row.get("itemId")))
        if item is None:
            audited.append(
                {
                    "itemId": row.get("itemId"),
                    "family": family,
                    "outcome": row.get("outcome"),
                    "classification": "needs_human_review",
                    "rationale": "item_missing_from_dataset_index",
                    "expected": None,
                    "parsedAnswer": None,
                    "rawPredictionPreview": str(row.get("rawPrediction") or "")[:800],
                },
            )
            continue
        classification = classify_failure(
            row,
            item["expected"],
            enable_thinking=enable_thinking,
            prompt=item.get("prompt"),
        )
        raw_full = str(row.get("rawPrediction") or "")
        audited.append(
            {
                "itemId": item["id"],
                "family": family,
                "difficulty": item.get("difficulty"),
                "sampleIndex": row.get("sampleIndex"),
                "outcome": row.get("outcome"),
                "truncated": bool(row.get("truncated")),
                "invalidReason": row.get("invalidReason"),
                "expected": strip_correction_metadata(
                    correct_expected(item["expected"], prompt=item.get("prompt")),
                ),
                "prompt": item.get("prompt"),
                "parsedAnswer": classification.get("parsedAnswer"),
                "classification": classification["classification"],
                "rationale": classification["rationale"],
                "independentEqual": classification.get("independentEqual"),
                "comparable": classification.get("comparable"),
                # Full raw retained for reconcile (sample sizes are small).
                "rawPrediction": raw_full,
                "rawPredictionPreview": raw_full[:800],
                "rawPredictionLength": len(raw_full),
                "previewTruncated": len(raw_full) > 800,
                "graderVersionAtAudit": GRADER_VERSION,
                "auditVersion": AUDIT_VERSION,
            },
        )
    return audited


def build_weak_family_audit(
    *,
    artifact_dir: Path,
    dataset_path: Path,
    sample_size: int = 10,
    seed: int = 18,
) -> dict[str, Any]:
    artifact_dir = artifact_dir.resolve()
    expected_index = _load_expected_index(dataset_path)
    modes: dict[str, Any] = {}
    confirmed_grader_misses = 0

    for cid, enable_thinking in (
        ("thinking_disabled_zero_shot", False),
        ("thinking_enabled_zero_shot", True),
    ):
        path = resolve_condition_artifact(artifact_dir, cid)
        if path is None:
            modes[cid] = {"ok": False, "error": "item_results_missing"}
            continue
        results = _load_results(path)
        families: dict[str, Any] = {}
        for fam in WEAK_FAMILIES:
            samples = sample_family_failures(
                results,
                family=fam,
                expected_index=expected_index,
                enable_thinking=enable_thinking,
                sample_size=sample_size,
                seed=seed,
            )
            miss_n = sum(1 for s in samples if s.get("classification") == "grader_miss")
            confirmed_grader_misses += miss_n
            families[fam] = {
                "sampled": len(samples),
                "graderMissCount": miss_n,
                "genuineMathErrorCount": sum(
                    1 for s in samples if s.get("classification") == "genuine_math_error"
                ),
                "insufficientResponseCount": sum(
                    1 for s in samples if s.get("classification") == "insufficient_response"
                ),
                "needsHumanReviewCount": sum(
                    1 for s in samples if s.get("classification") == "needs_human_review"
                ),
                "samples": samples,
            }
        modes[cid] = {
            "ok": True,
            "sourcePath": str(path),
            "families": families,
        }

    return {
        "ok": all(m.get("ok") for m in modes.values()),
        "auditVersion": AUDIT_VERSION,
        "auditVersionSupersedes": AUDIT_VERSION_PREVIOUS,
        "independenceNote": (
            "genuine_math_error requires an independent unequal comparison; "
            "historical grader wrong labels are never sufficient."
        ),
        "graderVersion": GRADER_VERSION,
        "artifactDir": str(artifact_dir),
        "datasetPath": str(dataset_path.resolve()),
        "sampleSizePerFamily": sample_size,
        "seed": seed,
        "targetFamilies": list(WEAK_FAMILIES),
        "modes": modes,
        "confirmedGraderMissTotal": confirmed_grader_misses,
        "stageBBlockedOnGraderMiss": confirmed_grader_misses > 0,
        "lockedDataAccessed": False,
        "policy": (
            "Any confirmed grader_miss must be fixed as a versioned grader change "
            "before Stage B. Do not silently rescore historical artifacts."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path(__file__).resolve().parent / "datasets" / "dev" / "id_dev.jsonl",
    )
    parser.add_argument("--sample-size", type=int, default=10)
    parser.add_argument("--seed", type=int, default=18)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = build_weak_family_audit(
        artifact_dir=args.artifact_dir,
        dataset_path=args.dataset,
        sample_size=args.sample_size,
        seed=args.seed,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "auditVersion": report["auditVersion"],
                "confirmedGraderMissTotal": report["confirmedGraderMissTotal"],
                "stageBBlockedOnGraderMiss": report["stageBBlockedOnGraderMiss"],
                "out": str(args.out),
            },
            indent=2,
        ),
    )
    if not report["ok"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
