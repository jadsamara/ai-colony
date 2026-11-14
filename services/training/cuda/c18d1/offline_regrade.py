#!/usr/bin/env python3
"""Offline regrade of saved C1.8D model outputs (no new generations).

Regrades item-results under grader v3.4 + exact expected corrections.
Writes a fresh report directory; never overwrites historical evaluation results
or locked datasets.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from answer_parser import GRADER_VERSION
from exact_repr import EXPECTED_CORRECTION_VERSION, correct_expected, strip_correction_metadata
from family_diagnostics import build_per_family_report, resolve_condition_artifact, _load_results
from generators import GENERATOR_VERSION, GENERATOR_VERSION_PREVIOUS
from sympy_grader import grade_model_output

REGRADE_VERSION = "c18d1-offline-regrade-v1"


def _load_items(dataset_path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for line in dataset_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        out[str(item["id"])] = item
    return out


def regrade_rows(
    rows: list[dict[str, Any]],
    items: dict[str, dict[str, Any]],
    *,
    enable_thinking: bool,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    regraded: list[dict[str, Any]] = []
    false_neg = 0  # historical not-correct, corrected correct
    false_pos = 0  # historical correct, corrected not-correct
    missing_item = 0
    for row in rows:
        item = items.get(str(row.get("itemId")))
        if item is None:
            missing_item += 1
            regraded.append(
                {
                    **row,
                    "regradeStatus": "missing_item",
                    "originalOutcome": row.get("outcome"),
                    "outcome": "grader_error",
                    "correct": False,
                },
            )
            continue
        expected = strip_correction_metadata(
            correct_expected(item["expected"], prompt=item.get("prompt")),
        )
        graded = grade_model_output(
            str(row.get("rawPrediction") or ""),
            expected,
            enable_thinking=enable_thinking,
            truncated=bool(row.get("truncated")),
        )
        orig = str(row.get("outcome") or "")
        new = str(graded.get("outcome") or "")
        orig_ok = orig == "correct"
        new_ok = new == "correct"
        if (not orig_ok) and new_ok:
            false_neg += 1
        if orig_ok and (not new_ok):
            false_pos += 1
        regraded.append(
            {
                "itemId": row.get("itemId"),
                "family": row.get("family") or item.get("family"),
                "difficulty": row.get("difficulty") or item.get("difficulty"),
                "sampleIndex": row.get("sampleIndex"),
                "samplingSeed": row.get("samplingSeed"),
                "rawPrediction": row.get("rawPrediction"),
                "truncated": row.get("truncated"),
                "originalOutcome": orig,
                "originalCorrect": bool(row.get("correct")),
                "originalGraderVersion": row.get("graderVersion"),
                "outcome": new,
                "correct": bool(graded.get("correct")),
                "mathematicalCorrect": graded.get("mathematicalCorrect"),
                "formatCompliant": graded.get("formatCompliant"),
                "invalidReason": graded.get("invalidReason"),
                "parsed": graded.get("parsed"),
                "grade": graded.get("grade"),
                "graderError": graded.get("graderError"),
                "graderVersion": graded.get("graderVersion", GRADER_VERSION),
                "expectedUsed": expected,
                "generatedTokens": row.get("generatedTokens"),
                "runtimeMs": row.get("runtimeMs"),
                "regradeStatus": "ok",
                "transition": f"{orig}->{new}",
            },
        )
    stats = {
        "rowCount": len(rows),
        "missingItemCount": missing_item,
        "falseNegativesGradingDefect": false_neg,
        "falsePositivesGradingDefect": false_pos,
    }
    return regraded, stats


def _accuracy(rows: list[dict[str, Any]], *, outcome_key: str = "outcome") -> float:
    n = len(rows)
    if not n:
        return 0.0
    return sum(1 for r in rows if r.get(outcome_key) == "correct") / n


def regrade_artifact_dir(
    *,
    artifact_dir: Path,
    dataset_path: Path,
    output_dir: Path,
) -> dict[str, Any]:
    artifact_dir = artifact_dir.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    items = _load_items(dataset_path)

    modes: dict[str, Any] = {}
    for cid, enable_thinking in (
        ("thinking_disabled_zero_shot", False),
        ("thinking_enabled_zero_shot", True),
    ):
        src = resolve_condition_artifact(artifact_dir, cid)
        if src is None:
            modes[cid] = {"ok": False, "error": "item_results_missing"}
            continue
        rows = _load_results(src)
        new_rows, stats = regrade_rows(rows, items, enable_thinking=enable_thinking)
        orig_acc = _accuracy(
            [{"outcome": r.get("outcome")} for r in rows],
        )
        # original outcomes already on rows
        orig_acc = sum(1 for r in rows if r.get("outcome") == "correct") / (len(rows) or 1)
        new_acc = sum(1 for r in new_rows if r.get("outcome") == "correct") / (len(new_rows) or 1)

        family_orig: dict[str, list[dict[str, Any]]] = defaultdict(list)
        family_new: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for o, n in zip(rows, new_rows):
            fam = str(n.get("family") or o.get("family") or "unknown")
            family_orig[fam].append(o)
            family_new[fam].append(n)
        per_family = {}
        for fam in sorted(set(family_orig) | set(family_new)):
            o_rows = family_orig.get(fam, [])
            n_rows = family_new.get(fam, [])
            per_family[fam] = {
                "originalAccuracy": sum(1 for r in o_rows if r.get("outcome") == "correct")
                / (len(o_rows) or 1),
                "correctedAccuracy": sum(1 for r in n_rows if r.get("outcome") == "correct")
                / (len(n_rows) or 1),
                "original": build_per_family_report(o_rows, condition_id=cid)["perFamily"].get(fam),
                "corrected": build_per_family_report(n_rows, condition_id=cid)["perFamily"].get(fam),
            }

        remaining = {
            "wrong": sum(1 for r in new_rows if r.get("outcome") == "wrong"),
            "invalid": sum(1 for r in new_rows if r.get("outcome") == "invalid"),
            "truncated": sum(1 for r in new_rows if r.get("outcome") == "truncated"),
            "grader_error": sum(1 for r in new_rows if r.get("outcome") == "grader_error"),
            "correct": sum(1 for r in new_rows if r.get("outcome") == "correct"),
        }
        out_rows = output_dir / f"regraded-{cid}.json"
        out_rows.write_text(
            json.dumps(
                {
                    "access": "evaluation_only",
                    "regradeVersion": REGRADE_VERSION,
                    "graderVersion": GRADER_VERSION,
                    "sourcePath": str(src),
                    "results": new_rows,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        modes[cid] = {
            "ok": True,
            "sourcePath": str(src),
            "regradedPath": str(out_rows),
            "originalAccuracy": orig_acc,
            "correctedAccuracy": new_acc,
            "accuracyDelta": new_acc - orig_acc,
            "falseNegativesGradingDefect": stats["falseNegativesGradingDefect"],
            "falsePositivesGradingDefect": stats["falsePositivesGradingDefect"],
            "missingItemCount": stats["missingItemCount"],
            "remainingOutcomes": remaining,
            "perFamily": per_family,
            "familyDiagnosticsCorrected": build_per_family_report(
                new_rows,
                condition_id=cid,
                source_path=str(out_rows),
            ),
        }

    report = {
        "ok": all(m.get("ok") for m in modes.values()),
        "regradeVersion": REGRADE_VERSION,
        "methodology": (
            "CPU-only offline regrade of saved rawPrediction fields. "
            "No new model generations. Exact expected corrections applied via "
            f"{EXPECTED_CORRECTION_VERSION}. Historical artifact files untouched."
        ),
        "provenance": {
            "graderVersion": GRADER_VERSION,
            "expectedCorrectionVersion": EXPECTED_CORRECTION_VERSION,
            "generatorVersionCurrent": GENERATOR_VERSION,
            "generatorVersionArtifactDataset": GENERATOR_VERSION_PREVIOUS,
            "datasetPath": str(dataset_path.resolve()),
            "artifactDir": str(artifact_dir),
            "outputDir": str(output_dir),
            "lockedDataAccessed": False,
            "historicalResultsOverwritten": False,
        },
        "modes": modes,
    }
    (output_dir / "offline-regrade-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path(__file__).resolve().parent / "datasets" / "historical" / "id_dev.gen-v2.jsonl",
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not args.dataset.is_file():
        # Fallback to current id_dev if historical copy not yet created.
        fallback = Path(__file__).resolve().parent / "datasets" / "dev" / "id_dev.jsonl"
        if fallback.is_file():
            args.dataset = fallback
        else:
            raise SystemExit(f"dataset missing: {args.dataset}")
    report = regrade_artifact_dir(
        artifact_dir=args.artifact_dir,
        dataset_path=args.dataset,
        output_dir=args.out,
    )
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "out": str(args.out / "offline-regrade-report.json"),
                "modes": {
                    k: {
                        "originalAccuracy": v.get("originalAccuracy"),
                        "correctedAccuracy": v.get("correctedAccuracy"),
                        "falseNegativesGradingDefect": v.get("falseNegativesGradingDefect"),
                        "falsePositivesGradingDefect": v.get("falsePositivesGradingDefect"),
                    }
                    for k, v in report["modes"].items()
                },
            },
            indent=2,
        ),
    )
    if not report["ok"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
