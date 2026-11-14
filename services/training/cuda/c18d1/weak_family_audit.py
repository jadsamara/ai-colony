#!/usr/bin/env python3
"""Weak-family wrong/invalid audit from existing C1.8D evaluation artifacts.

For each target family, sample up to N wrong/invalid/grader_error rows,
join expected answers from the development dataset, and classify each as
genuine_math_error vs grader_miss (vs needs_human_review).

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
from family_diagnostics import WEAK_FAMILIES, _load_results, resolve_condition_artifact
from sympy_grader import answers_canonically_equal, grade_answer, grade_model_output

AUDIT_VERSION = "c18d1-weak-family-audit-v1"


def _load_expected_index(dataset_path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for line in dataset_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        out[str(item["id"])] = item
    return out


def _parsed_answer(row: dict[str, Any]) -> str | None:
    parsed = row.get("parsed") or {}
    if isinstance(parsed, dict):
        for key in ("mathText", "answer"):
            if parsed.get(key):
                return str(parsed[key])
    return None


def classify_failure(
    row: dict[str, Any],
    expected: dict[str, Any],
    *,
    enable_thinking: bool,
) -> dict[str, Any]:
    """Classify a wrong/invalid/grader_error row against current grader."""
    raw = str(row.get("rawPrediction") or "")
    parsed_ans = _parsed_answer(row)
    outcome = str(row.get("outcome") or "")

    # Re-grade with current grader; if now correct → grader_miss (historical).
    try:
        regraded = grade_model_output(
            raw,
            expected,
            enable_thinking=enable_thinking,
            truncated=bool(row.get("truncated")),
        )
    except Exception as exc:  # noqa: BLE001
        return {
            "classification": "needs_human_review",
            "rationale": f"regrade_exception:{type(exc).__name__}",
            "regradedOutcome": "grader_error",
            "parsedAnswer": parsed_ans,
        }

    if regraded.get("outcome") == "correct":
        return {
            "classification": "grader_miss",
            "rationale": "current_grader_marks_correct",
            "regradedOutcome": "correct",
            "parsedAnswer": parsed_ans or regraded.get("parsed", {}).get("mathText"),
        }

    if outcome == "grader_error" or regraded.get("outcome") == "grader_error":
        return {
            "classification": "grader_miss",
            "rationale": "grader_exception_or_historical_grader_error",
            "regradedOutcome": regraded.get("outcome"),
            "parsedAnswer": parsed_ans,
        }

    if parsed_ans:
        try:
            direct = grade_answer(parsed_ans, expected)
            if direct.get("correct"):
                return {
                    "classification": "grader_miss",
                    "rationale": "parsed_answer_grades_correct_under_current_grader",
                    "regradedOutcome": regraded.get("outcome"),
                    "parsedAnswer": parsed_ans,
                }
        except Exception:
            pass
        # Canonical equality to a simple expected rendering when available
        expected_render = None
        if expected.get("kind") == "roots":
            expected_render = ", ".join(str(v) for v in expected.get("values") or [])
        elif expected.get("kind") == "no_solution":
            expected_render = "no solution"
        elif expected.get("kind") == "expression":
            expected_render = str(expected.get("value"))
        if expected_render is not None:
            eq = answers_canonically_equal(parsed_ans, expected_render)
            if eq.get("equal"):
                return {
                    "classification": "grader_miss",
                    "rationale": "parsed_canonically_equals_expected_render",
                    "regradedOutcome": regraded.get("outcome"),
                    "parsedAnswer": parsed_ans,
                }

    if outcome in {"invalid", "truncated"} and not parsed_ans:
        return {
            "classification": "genuine_math_error",
            "rationale": "missing_or_unparseable_final_answer",
            "regradedOutcome": regraded.get("outcome"),
            "parsedAnswer": None,
        }

    if regraded.get("outcome") == "wrong":
        return {
            "classification": "genuine_math_error",
            "rationale": "current_grader_marks_wrong",
            "regradedOutcome": "wrong",
            "parsedAnswer": parsed_ans,
        }

    return {
        "classification": "needs_human_review",
        "rationale": f"ambiguous_outcome:{outcome}->{regraded.get('outcome')}",
        "regradedOutcome": regraded.get("outcome"),
        "parsedAnswer": parsed_ans,
    }


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
                    "parsedAnswer": _parsed_answer(row),
                    "rawPredictionPreview": str(row.get("rawPrediction") or "")[:800],
                },
            )
            continue
        classification = classify_failure(
            row,
            item["expected"],
            enable_thinking=enable_thinking,
        )
        audited.append(
            {
                "itemId": item["id"],
                "family": family,
                "difficulty": item.get("difficulty"),
                "sampleIndex": row.get("sampleIndex"),
                "outcome": row.get("outcome"),
                "invalidReason": row.get("invalidReason"),
                "expected": item["expected"],
                "parsedAnswer": classification.get("parsedAnswer"),
                "classification": classification["classification"],
                "rationale": classification["rationale"],
                "regradedOutcome": classification.get("regradedOutcome"),
                "rawPredictionPreview": str(row.get("rawPrediction") or "")[:800],
                "graderVersionAtAudit": GRADER_VERSION,
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
