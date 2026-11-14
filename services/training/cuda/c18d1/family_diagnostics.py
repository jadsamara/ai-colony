#!/usr/bin/env python3
"""Per-family diagnostics from C1.8D noise-floor / eval item-result artifacts.

Builds matching thinking-enabled and thinking-disabled family reports:
accuracy, correct/wrong/invalid/truncated/grader_error, token stats,
missing-final-answer rates. Does not access locked Stage C data.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from answer_parser import GRADER_VERSION

REPORT_VERSION = "c18d1-family-diagnostics-v1"

WEAK_FAMILIES = (
    "exponential_log_equations",
    "polynomial_factorization",
    "quadratic_equations",
    "symbolic_simplification",
)


def _load_results(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return payload
    return list(payload.get("results") or [])


def _token_stats(vals: list[float]) -> dict[str, Any]:
    if not vals:
        return {
            "count": 0,
            "mean": None,
            "p50": None,
            "p90": None,
            "max": None,
            "sum": 0,
        }
    ordered = sorted(vals)
    n = len(ordered)

    def pct(p: float) -> float:
        idx = min(n - 1, max(0, int(math.ceil(p * n) - 1)))
        return float(ordered[idx])

    return {
        "count": n,
        "mean": sum(ordered) / n,
        "p50": pct(0.50),
        "p90": pct(0.90),
        "max": float(ordered[-1]),
        "sum": int(sum(ordered)),
    }


def summarize_family_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """One family (or overall) outcome + token summary matching disabled-mode structure."""
    n = len(rows)
    counts = {
        "correct": 0,
        "wrong": 0,
        "invalid": 0,
        "truncated": 0,
        "grader_error": 0,
    }
    missing_final = 0
    tokens: list[float] = []
    runtimes: list[float] = []
    for row in rows:
        outcome = str(row.get("outcome") or "")
        if outcome in counts:
            counts[outcome] += 1
        inv = str(row.get("invalidReason") or "")
        if outcome in {"invalid", "truncated"} and inv in {
            "no_answer_line",
            "no_answer_marker",
            "missing",
            "empty",
            "malformed",
            "empty_answer_payload",
        }:
            missing_final += 1
        elif outcome == "truncated":
            missing_final += 1
        if row.get("generatedTokens") is not None:
            tokens.append(float(row["generatedTokens"]))
        if row.get("runtimeMs") is not None:
            runtimes.append(float(row["runtimeMs"]))
    return {
        "sampleSize": n,
        "accuracy": (counts["correct"] / n) if n else 0.0,
        "correct": counts["correct"],
        "wrong": counts["wrong"],
        "invalid": counts["invalid"],
        "truncated": counts["truncated"],
        "grader_error": counts["grader_error"],
        "missingFinalAnswerCount": missing_final,
        "missingFinalAnswerRate": (missing_final / n) if n else 0.0,
        "generatedTokens": _token_stats(tokens),
        "runtimeMs": _token_stats(runtimes),
    }


def build_per_family_report(
    results: list[dict[str, Any]],
    *,
    condition_id: str,
    source_path: str | None = None,
) -> dict[str, Any]:
    by_family: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in results:
        by_family[str(row.get("family") or "unknown")].append(row)
    families = {
        fam: summarize_family_rows(rows)
        for fam, rows in sorted(by_family.items())
    }
    return {
        "reportVersion": REPORT_VERSION,
        "graderVersion": GRADER_VERSION,
        "conditionId": condition_id,
        "sourcePath": source_path,
        "overall": summarize_family_rows(results),
        "perFamily": families,
        "weakFamiliesHighlight": {
            fam: families.get(fam)
            for fam in WEAK_FAMILIES
            if fam in families
        },
        "outcomeClasses": [
            "correct",
            "wrong",
            "invalid",
            "truncated",
            "grader_error",
        ],
        "note": (
            "grader_error is counted separately from invalid/wrong/truncated. "
            "Multiple samples of one item are not independent benchmark questions."
        ),
    }


def resolve_condition_artifact(
    artifact_dir: Path,
    condition_id: str,
    *,
    prefer: str = "same-seed-run1",
) -> Path | None:
    """Locate item-results JSON for a condition inside a noise-floor output dir."""
    candidates = [
        artifact_dir / f"item-results-{condition_id}-{prefer}.json",
        artifact_dir / f"item-results-{condition_id}-same-seed-run1.json",
        artifact_dir / f"item-results-{condition_id}-same-seed-run2.json",
        artifact_dir / f"item-results-{condition_id}-alt-seed-run.json",
        artifact_dir / "item-results.json",
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def build_dual_mode_report(artifact_dir: Path) -> dict[str, Any]:
    artifact_dir = artifact_dir.resolve()
    modes: dict[str, Any] = {}
    for cid in ("thinking_disabled_zero_shot", "thinking_enabled_zero_shot"):
        path = resolve_condition_artifact(artifact_dir, cid)
        if path is None:
            modes[cid] = {"ok": False, "error": "item_results_missing"}
            continue
        results = _load_results(path)
        modes[cid] = {
            "ok": True,
            **build_per_family_report(results, condition_id=cid, source_path=str(path)),
        }
    noise_report = artifact_dir / "noise-floor-report.json"
    return {
        "ok": all(m.get("ok") for m in modes.values()),
        "reportVersion": REPORT_VERSION,
        "artifactDir": str(artifact_dir),
        "noiseFloorReportPresent": noise_report.is_file(),
        "modes": modes,
        "lockedDataAccessed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        required=True,
        help="Noise-floor or eval output directory containing item-results-*.json",
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = build_dual_mode_report(args.artifact_dir)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "out": str(args.out)}, indent=2))
    if not report["ok"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
