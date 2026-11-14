#!/usr/bin/env python3
"""Independently verified Math smoke packets for Gemma reviewer validation.

CPU-only construction. These packets are graded with SymPy independently so
smoke success/failure is not circular with the Qwen eval grader path beyond
shared exact math. Do not reveal expected/grades to the reviewer at serve time.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from exact_repr import exact_pow2
from independent_check import independent_equals
from reviewer_gemma3 import PINNED_GEMMA3_27B_IT, PROPOSED_REVIEWER

SMOKE_SPEC_VERSION = "c18d1-gemma-smoke-validation-v1"


def build_smoke_cases() -> list[dict[str, Any]]:
    """12 cases: 6 independently correct, 6 incorrect/insufficient."""
    cases: list[dict[str, Any]] = []

    correct_specs = [
        (
            "Solve for x. End with ANSWER.\n\n2*x + 4 = 10",
            "ANSWER: 3",
            {"kind": "roots", "values": ["3"]},
        ),
        (
            "Solve for x.\n\nx**2 - 5*x + 6 = 0",
            "ANSWER: 2, 3",
            {"kind": "roots", "values": ["2", "3"]},
        ),
        (
            "Solve over reals (x>0).\n\nlog(x)/log(2) = -40",
            f"**ANSWER: {exact_pow2(-40)}**",
            {"kind": "roots", "values": [exact_pow2(-40)]},
        ),
        (
            "Solve over reals (x>0).\n\nlog(x)/log(2) = -24",
            f"ANSWER: {exact_pow2(-24)}",
            {"kind": "roots", "values": [exact_pow2(-24)]},
        ),
        (
            "Solve over reals (x>0).\n\nlog(x)/log(2) = 63",
            f"ANSWER: {exact_pow2(63)}",
            {"kind": "roots", "values": [exact_pow2(63)]},
        ),
        (
            "Solve.\n\n|x - 1| = 2",
            r"\textbf{ANSWER: } -1, 3",
            {"kind": "roots", "values": ["-1", "3"]},
        ),
    ]
    for i, (problem, response, expected) in enumerate(correct_specs):
        cases.append(
            {
                "smokeId": f"correct-{i}",
                "label": "independently_correct",
                "blind": {"problemStatement": problem, "rawModelResponse": response},
                "hidden": {"expected": expected, "independentTruth": "correct"},
            },
        )

    incorrect_specs = [
        (
            "Solve for x.\n\n2*x + 4 = 10",
            "ANSWER: 7",
            {"kind": "roots", "values": ["3"]},
        ),
        (
            "Solve for x.\n\nx**2 - 5*x + 6 = 0",
            "ANSWER: 1, 6",
            {"kind": "roots", "values": ["2", "3"]},
        ),
        (
            "Solve over reals (x>0).\n\nlog(x)/log(2) = -40",
            "ANSWER: 0",
            {"kind": "roots", "values": [exact_pow2(-40)]},
        ),
        (
            "Solve.\n\n|x - 1| = 2",
            "ANSWER: 1",
            {"kind": "roots", "values": ["-1", "3"]},
        ),
        (
            "Solve for x.\n\n3*x = 12",
            "I think it might be four but I am unsure.",
            {"kind": "roots", "values": ["4"]},
        ),
        (
            "Solve for x.\n\nx - 1 = 0",
            "The answer is somewhere near 1.",
            {"kind": "roots", "values": ["1"]},
        ),
    ]
    for i, (problem, response, expected) in enumerate(incorrect_specs):
        cases.append(
            {
                "smokeId": f"incorrect-{i}",
                "label": "independently_incorrect_or_insufficient",
                "blind": {"problemStatement": problem, "rawModelResponse": response},
                "hidden": {
                    "expected": expected,
                    "independentTruth": "incorrect_or_insufficient",
                },
            },
        )

    # Attach independent verification records (for operator, not for reviewer).
    from independent_check import extract_candidate

    verified: list[dict[str, Any]] = []
    for case in cases:
        ext = extract_candidate(case["blind"]["rawModelResponse"], enable_thinking=False)
        eq = independent_equals(ext.get("mathText"), case["hidden"]["expected"])
        if case["label"] == "independently_correct":
            assert eq.get("equal") is True and eq.get("comparable") is True, case["smokeId"]
        else:
            # Either unequal or not extractable
            assert not (eq.get("equal") is True and eq.get("comparable") is True), case["smokeId"]
        verified.append(
            {
                **case,
                "hidden": {
                    **case["hidden"],
                    "extractedMathText": ext.get("mathText"),
                    "independentEqual": eq.get("equal"),
                    "independentComparable": eq.get("comparable"),
                },
            },
        )
    return verified


def write_smoke_bundle(out_dir: Path) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    cases = build_smoke_cases()
    blind_only = [
        {
            "smokeId": c["smokeId"],
            "blind": c["blind"],
            # No expected / truth fields in reviewer-facing file.
        }
        for c in cases
    ]
    (out_dir / "gemma-smoke-blind-packets.json").write_text(
        json.dumps(blind_only, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (out_dir / "gemma-smoke-hidden-labels.json").write_text(
        json.dumps(
            [{"smokeId": c["smokeId"], "label": c["label"], "hidden": c["hidden"]} for c in cases],
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    manifest = {
        "ok": True,
        "smokeSpecVersion": SMOKE_SPEC_VERSION,
        "caseCount": len(cases),
        "correctCount": sum(1 for c in cases if c["label"] == "independently_correct"),
        "incorrectOrInsufficientCount": sum(
            1 for c in cases if c["label"] != "independently_correct"
        ),
        "reviewer": {
            "modelId": PINNED_GEMMA3_27B_IT["modelId"],
            "modelRevision": PINNED_GEMMA3_27B_IT["modelRevision"],
            "sampling": PROPOSED_REVIEWER["sampling"],
        },
        "passCriteria": (
            "Reviewer mathJudgment agrees with independentTruth on ≥10/12 cases; "
            "disagreements adjudicated with SymPy — Gemma never overrides exact math."
        ),
        "gpuWorkloadAuthorized": False,
        "note": "CPU bundle only. Serve Gemma and score only after proposal approval.",
    }
    (out_dir / "gemma-smoke-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent / "fixtures" / "gemma_smoke",
    )
    args = parser.parse_args()
    manifest = write_smoke_bundle(args.out)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
