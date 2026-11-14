#!/usr/bin/env python3
"""Reconcile weak-family audit grader_miss samples against the current grader stack.

Distinguishes:
- ``historical_corrected`` — current grader v3.4 + exact expected overlay marks correct
  (defect already fixed; do not treat as an open Stage B blocker)
- ``remaining_defect`` — still not graded correct under the current stack
- ``needs_raw_output`` — sample lacks rawPrediction for re-check

Does not invent VM artifact contents. Does not overwrite historical eval files.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from answer_parser import GRADER_VERSION, parse_model_output
from exact_repr import EXPECTED_CORRECTION_VERSION, correct_expected, strip_correction_metadata
from sympy_grader import grade_model_output

RECONCILE_VERSION = "c18d1-grader-miss-reconcile-v1"

# Defect classes corrected by versioned grader / expected overlays (not open blockers).
KNOWN_CORRECTED_DEFECT_CLASSES = (
    {
        "id": "markdown_bold_answer_marker",
        "fixedIn": "c18d1-grader-v3.4",
        "patternHint": r"\*\*ANSWER:",
        "description": "Markdown-bold **ANSWER:** / **ANSWER: …** markers were not extracted.",
    },
    {
        "id": "latex_textbf_mathrm_mathbf_answer",
        "fixedIn": "c18d1-grader-v3.4",
        "patternHint": r"\\(?:textbf|mathrm|mathbf)\s*\{\s*ANSWER:",
        "description": "LaTeX \\textbf/\\mathrm/\\mathbf{ANSWER:…} wrappers were not extracted.",
    },
    {
        "id": "text_answer_marker",
        "fixedIn": "c18d1-grader-v3.2",
        "patternHint": r"\\text\s*\{\s*ANSWER:",
        "description": "\\text{ANSWER:…} markers were not extracted.",
    },
    {
        "id": "interval_float_vs_rational",
        "fixedIn": "c18d1-grader-v3.1",
        "patternHint": r"-0\.5|0\.5",
        "description": "Interval Float endpoints failed Rational equality.",
    },
    {
        "id": "emptyset_no_solution",
        "fixedIn": "c18d1-grader-v3.3",
        "patternHint": r"emptyset|\\emptyset|EmptySet",
        "description": "EmptySet / empty interval vs no-solution mismatch.",
    },
    {
        "id": "exact_pow2_expected",
        "fixedIn": "c18d1-expected-exact-v1 / c18d1-gen-v3",
        "patternHint": r"2\*\*-?\d+|1/\d{6,}",
        "description": "Floatish 2**k expectations (e.g. 2**-40) caused false wrongs.",
    },
)


def classify_defect_kind(raw: str, expected: dict[str, Any] | None = None) -> str:
    """Best-effort taxonomy label for a miss (for reporting, not adjudication)."""
    text = raw or ""
    if re.search(r"\*\*ANSWER:", text, re.I):
        return "markdown_bold_answer_marker"
    if re.search(r"\\(?:textbf|mathrm|mathbf)\s*\{\s*ANSWER:", text, re.I):
        return "latex_textbf_mathrm_mathbf_answer"
    if re.search(r"\\text\s*\{\s*ANSWER:", text, re.I):
        return "text_answer_marker"
    if re.search(r"\\emptyset|EmptySet|no solution", text, re.I):
        return "emptyset_no_solution"
    vals = []
    if expected and expected.get("kind") == "roots":
        vals = [str(v) for v in (expected.get("values") or [])]
    joined = " ".join(vals)
    if any("e-" in v.lower() or re.match(r"^-?\d+\.\d+$", v) for v in vals):
        return "exact_pow2_expected"
    if re.search(r"1/\d{6,}", text) or re.search(r"1/\d{6,}", joined):
        return "exact_pow2_expected"
    if re.search(r"-0\.5|0\.5", text) and ("(" in text or "[" in text):
        return "interval_float_vs_rational"
    return "other_or_unclassified"


def reconcile_sample(
    sample: dict[str, Any],
    *,
    enable_thinking: bool,
    prompt: str | None = None,
) -> dict[str, Any]:
    """Reconcile one weak-family grader_miss sample against the current grader."""
    raw = (
        sample.get("rawPrediction")
        or sample.get("rawPredictionPreview")
        or ""
    )
    expected_raw = sample.get("expected") or sample.get("expectedUsed")
    if not raw:
        return {
            "itemId": sample.get("itemId"),
            "family": sample.get("family"),
            "status": "needs_raw_output",
            "defectKind": None,
            "historicalOutcome": sample.get("outcome") or sample.get("historicalOutcome"),
            "rationale": "missing_raw_prediction",
        }
    if not expected_raw:
        return {
            "itemId": sample.get("itemId"),
            "family": sample.get("family"),
            "status": "needs_expected",
            "defectKind": classify_defect_kind(str(raw), None),
            "historicalOutcome": sample.get("outcome") or sample.get("historicalOutcome"),
            "rationale": "missing_expected",
        }

    expected = strip_correction_metadata(
        correct_expected(dict(expected_raw), prompt=prompt or sample.get("prompt")),
    )
    defect_kind = classify_defect_kind(str(raw), expected)
    known_fixed = {c["id"] for c in KNOWN_CORRECTED_DEFECT_CLASSES}
    graded = grade_model_output(
        str(raw),
        expected,
        enable_thinking=enable_thinking,
        truncated=bool(sample.get("truncated")),
    )
    parsed = parse_model_output(
        str(raw),
        enable_thinking=enable_thinking,
        truncated=bool(sample.get("truncated")),
    )
    now_correct = graded.get("outcome") == "correct"
    if now_correct:
        status = "historical_corrected"
        open_blocker = False
    else:
        status = "remaining_defect"
        open_blocker = True
    # Known corrected classes that still fail need human attention (unexpected).
    if status == "remaining_defect" and defect_kind in known_fixed:
        status = "remaining_defect_unexpected_for_known_class"

    return {
        "itemId": sample.get("itemId"),
        "family": sample.get("family"),
        "sampleIndex": sample.get("sampleIndex"),
        "status": status,
        "openStageBBlocker": open_blocker,
        "defectKind": defect_kind,
        "knownCorrectedClass": defect_kind in known_fixed,
        "historicalOutcome": sample.get("outcome") or sample.get("historicalOutcome"),
        "currentOutcome": graded.get("outcome"),
        "currentCorrect": bool(graded.get("correct")),
        "formatCompliant": graded.get("formatCompliant"),
        "parseOk": bool(parsed.get("ok")),
        "parsedMathText": parsed.get("mathText") or parsed.get("answer"),
        "expectedUsed": expected,
        "graderVersion": GRADER_VERSION,
        "expectedCorrectionVersion": EXPECTED_CORRECTION_VERSION,
        "rawPredictionPreview": str(raw)[:800],
    }


def extract_grader_misses(weak_audit: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten grader_miss samples from a weak-family audit v2 report."""
    out: list[dict[str, Any]] = []
    for cid, mode in (weak_audit.get("modes") or {}).items():
        enable = "thinking_enabled" in cid
        for fam, block in (mode.get("families") or {}).items():
            for sample in block.get("samples") or []:
                if sample.get("classification") != "grader_miss":
                    continue
                out.append(
                    {
                        **sample,
                        "conditionId": cid,
                        "enableThinking": enable,
                        "family": sample.get("family") or fam,
                    },
                )
    return out


def reconcile_weak_family_audit(weak_audit: dict[str, Any]) -> dict[str, Any]:
    misses = extract_grader_misses(weak_audit)
    reconciled = []
    for sample in misses:
        reconciled.append(
            reconcile_sample(
                sample,
                enable_thinking=bool(sample.get("enableThinking")),
                prompt=sample.get("prompt"),
            ),
        )
    hist = sum(1 for r in reconciled if r["status"] == "historical_corrected")
    remaining = sum(1 for r in reconciled if str(r["status"]).startswith("remaining_defect"))
    needs = sum(
        1
        for r in reconciled
        if r["status"] in {"needs_raw_output", "needs_expected"}
    )
    by_kind: dict[str, int] = {}
    for r in reconciled:
        k = str(r.get("defectKind") or "unknown")
        by_kind[k] = by_kind.get(k, 0) + 1

    return {
        "ok": True,
        "reconcileVersion": RECONCILE_VERSION,
        "graderVersion": GRADER_VERSION,
        "expectedCorrectionVersion": EXPECTED_CORRECTION_VERSION,
        "knownCorrectedDefectClasses": KNOWN_CORRECTED_DEFECT_CLASSES,
        "inputMissCount": len(misses),
        "historicalCorrectedCount": hist,
        "remainingDefectCount": remaining,
        "needsMoreEvidenceCount": needs,
        "openStageBBlockerCount": sum(1 for r in reconciled if r.get("openStageBBlocker")),
        "byDefectKind": by_kind,
        "samples": reconciled,
        "policy": (
            "historical_corrected misses are not open Stage B blockers. "
            "remaining_defect requires a versioned grader/expected fix before Stage B. "
            "LLM judgments never authorize promotion."
        ),
        "sourceAuditVersion": weak_audit.get("auditVersion"),
        "lockedDataAccessed": False,
    }


def build_synthetic_ten_miss_fixture() -> dict[str, Any]:
    """Ten synthetic grader_miss rows covering known corrected classes + one remaining.

    Used for CPU regression when VM weak-family JSON is unavailable. Not claimed as
    the operator's live artifact counts.
    """
    from exact_repr import exact_pow2

    samples = [
        # 1–4 markdown bold (v3.4)
        *[
            {
                "itemId": f"syn-md-{i}",
                "family": "quadratic_equations",
                "outcome": "wrong",
                "classification": "grader_miss",
                "rawPrediction": f"**ANSWER: {i + 1}**",
                "expected": {"kind": "roots", "values": [str(i + 1)]},
            }
            for i in range(4)
        ],
        # 5–6 latex wrappers (v3.4)
        {
            "itemId": "syn-latex-1",
            "family": "symbolic_simplification",
            "outcome": "wrong",
            "classification": "grader_miss",
            "rawPrediction": r"\textbf{ANSWER: } 3",
            "expected": {"kind": "roots", "values": ["3"]},
        },
        {
            "itemId": "syn-latex-2",
            "family": "symbolic_simplification",
            "outcome": "wrong",
            "classification": "grader_miss",
            "rawPrediction": r"\mathrm{ANSWER: 5}",
            "expected": {"kind": "roots", "values": ["5"]},
        },
        # 7–8 exact pow2 (expected-exact-v1)
        {
            "itemId": "syn-pow2-40",
            "family": "exponential_log_equations",
            "outcome": "wrong",
            "classification": "grader_miss",
            "rawPrediction": f"ANSWER: {exact_pow2(-40)}",
            "expected": {"kind": "roots", "values": [exact_pow2(-40)]},
            "prompt": "Solve log(x)/log(2) = -40 for real x.",
        },
        {
            "itemId": "syn-pow2-24",
            "family": "exponential_log_equations",
            "outcome": "wrong",
            "classification": "grader_miss",
            "rawPrediction": f"ANSWER: {exact_pow2(-24)}",
            "expected": {"kind": "roots", "values": [exact_pow2(-24)]},
            "prompt": "Solve log(x)/log(2) = -24 for real x.",
        },
        # 9 interval float (v3.1)
        {
            "itemId": "syn-interval",
            "family": "polynomial_factorization",
            "outcome": "wrong",
            "classification": "grader_miss",
            "rawPrediction": "ANSWER: (-oo, -0.5)",
            "expected": {
                "kind": "interval",
                "left": "-oo",
                "right": "-1/2",
                "leftOpen": True,
                "rightOpen": True,
            },
        },
        # 10 remaining genuine mismatch under current grader
        {
            "itemId": "syn-remaining",
            "family": "quadratic_equations",
            "outcome": "wrong",
            "classification": "grader_miss",
            # Independent audit labeled miss incorrectly in a prior circular pass;
            # current stack grades this wrong (remaining if forced through reconcile).
            "rawPrediction": "ANSWER: 99",
            "expected": {"kind": "roots", "values": ["2"]},
        },
    ]
    # Wrap as a minimal weak-family audit document
    return {
        "ok": True,
        "auditVersion": "c18d1-weak-family-audit-v2",
        "confirmedGraderMissTotal": 10,
        "modes": {
            "thinking_disabled_zero_shot": {
                "ok": True,
                "families": {
                    "quadratic_equations": {
                        "samples": [s for s in samples if s["family"] == "quadratic_equations"],
                    },
                    "symbolic_simplification": {
                        "samples": [s for s in samples if s["family"] == "symbolic_simplification"],
                    },
                    "exponential_log_equations": {
                        "samples": [s for s in samples if s["family"] == "exponential_log_equations"],
                    },
                    "polynomial_factorization": {
                        "samples": [s for s in samples if s["family"] == "polynomial_factorization"],
                    },
                },
            },
        },
        "fixtureNote": (
            "Synthetic 10-miss fixture for CPU reconciliation regression. "
            "Replace with operator weak-family-audit-v2.json for live counts."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--weak-family-audit",
        type=Path,
        help="Path to weak-family-audit-v2.json (omit to use synthetic 10-miss fixture).",
    )
    parser.add_argument("--use-synthetic-fixture", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    if args.use_synthetic_fixture or args.weak_family_audit is None:
        weak = build_synthetic_ten_miss_fixture()
        source = "synthetic_ten_miss_fixture"
    else:
        weak = json.loads(args.weak_family_audit.read_text(encoding="utf-8"))
        source = str(args.weak_family_audit.resolve())

    report = reconcile_weak_family_audit(weak)
    report["sourcePath"] = source
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "inputMissCount": report["inputMissCount"],
                "historicalCorrectedCount": report["historicalCorrectedCount"],
                "remainingDefectCount": report["remainingDefectCount"],
                "openStageBBlockerCount": report["openStageBBlockerCount"],
                "out": str(args.out),
            },
            indent=2,
        ),
    )


if __name__ == "__main__":
    main()
