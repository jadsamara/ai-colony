#!/usr/bin/env python3
"""Reconcile weak-family audit grader_miss samples against the current grader stack.

v2 distinctions:
- ``historical_corrected`` — current grader v3.4 + exact expected marks correct
- ``incomplete_or_truncated_response`` — no usable final answer (NOT a grader defect;
  NOT a Stage B blocker)
- ``remaining_defect`` — complete response with extractable answer that current
  grader still fails (open Stage B blocker)
- ``needs_full_raw`` — only an 800-char preview was available and it omits ANSWER

Does not invent VM artifact contents. Does not overwrite historical eval files.
Preserves original response text and historical audit fields on each sample.
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

RECONCILE_VERSION = "c18d1-grader-miss-reconcile-v2"
RECONCILE_VERSION_PREVIOUS = "c18d1-grader-miss-reconcile-v1"

# Operator-flagged item from final preflight (incomplete — not a grader defect).
POLY_0042_ITEM_ID = (
    "c18d1-algebra-v2:development:polynomial_factorization:0042:38a978c18df8"
)

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

_ANSWER_MARKER = re.compile(
    r"(?is)(?:\*\*)?ANSWER\s*:|\\(?:text|textbf|mathrm|mathbf)\s*\{\s*ANSWER\s*:|\\boxed\s*\{",
)


def has_final_answer_marker(raw: str) -> bool:
    return bool(_ANSWER_MARKER.search(raw or ""))


def classify_defect_kind(raw: str, expected: dict[str, Any] | None = None) -> str:
    """Best-effort taxonomy label for a miss (for reporting, not adjudication)."""
    text = raw or ""
    if not has_final_answer_marker(text):
        return "incomplete_no_final_answer_marker"
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


def resolve_raw_text(sample: dict[str, Any]) -> dict[str, Any]:
    """Prefer full rawPrediction; detect preview-only truncation."""
    full = sample.get("rawPrediction")
    preview = sample.get("rawPredictionPreview")
    if full is not None and str(full):
        raw = str(full)
        return {
            "raw": raw,
            "source": "rawPrediction",
            "previewOnly": False,
            "rawLength": len(raw),
        }
    if preview is not None and str(preview):
        raw = str(preview)
        # Weak-family audit historically stored only [:800]
        preview_only = True
        may_omit = len(raw) >= 800 and not has_final_answer_marker(raw)
        return {
            "raw": raw,
            "source": "rawPredictionPreview",
            "previewOnly": preview_only,
            "previewMayOmitFinalAnswer": may_omit,
            "rawLength": len(raw),
        }
    return {
        "raw": "",
        "source": None,
        "previewOnly": False,
        "rawLength": 0,
    }


def is_incomplete_response(
    sample: dict[str, Any],
    *,
    raw: str,
    parsed: dict[str, Any],
) -> dict[str, Any]:
    """Decide whether the model failed to produce a usable final answer.

    Incomplete/truncated responses are **not** grader defects.
    """
    historical = str(sample.get("outcome") or sample.get("historicalOutcome") or "")
    if bool(sample.get("truncated")) or historical == "truncated":
        return {
            "incomplete": True,
            "reason": "truncated_flag_or_outcome",
            "evidence": {"truncated": sample.get("truncated"), "historicalOutcome": historical},
        }
    if not has_final_answer_marker(raw):
        return {
            "incomplete": True,
            "reason": "no_final_answer_marker",
            "evidence": {"rawLength": len(raw), "parseOk": bool(parsed.get("ok"))},
        }
    if not parsed.get("ok") or not (parsed.get("mathText") or parsed.get("answer")):
        # Marker present but empty / malformed → still incomplete, not a math grader miss
        reason = str(parsed.get("reason") or parsed.get("parseStatus") or "unparseable_marker")
        if reason in {"missing", "empty", "malformed", "no_extractable_answer"} or not parsed.get("ok"):
            return {
                "incomplete": True,
                "reason": f"marker_without_usable_answer:{reason}",
                "evidence": {"parseStatus": parsed.get("parseStatus"), "reason": parsed.get("reason")},
            }
    return {"incomplete": False, "reason": None, "evidence": {}}


def reconcile_sample(
    sample: dict[str, Any],
    *,
    enable_thinking: bool,
    prompt: str | None = None,
) -> dict[str, Any]:
    """Reconcile one weak-family grader_miss sample against the current grader."""
    resolved = resolve_raw_text(sample)
    raw = resolved["raw"]
    expected_raw = sample.get("expected") or sample.get("expectedUsed")
    historical = sample.get("outcome") or sample.get("historicalOutcome")

    base = {
        "itemId": sample.get("itemId"),
        "family": sample.get("family"),
        "sampleIndex": sample.get("sampleIndex"),
        "historicalOutcome": historical,
        "historicalClassification": sample.get("classification"),
        "historicalRationale": sample.get("rationale"),
        "graderVersion": GRADER_VERSION,
        "expectedCorrectionVersion": EXPECTED_CORRECTION_VERSION,
        "reconcileVersion": RECONCILE_VERSION,
        "rawSource": resolved.get("source"),
        "rawLength": resolved.get("rawLength"),
        "previewOnly": bool(resolved.get("previewOnly")),
        # Preserve original text for the record (cap stored preview; full when short).
        "rawPredictionPreserved": raw if len(raw) <= 4000 else raw[:4000],
        "rawPredictionPreview": raw[:800],
    }

    if not raw:
        return {
            **base,
            "status": "needs_raw_output",
            "openStageBBlocker": False,
            "defectKind": None,
            "rationale": "missing_raw_prediction",
        }

    if resolved.get("previewMayOmitFinalAnswer"):
        return {
            **base,
            "status": "needs_full_raw",
            "openStageBBlocker": False,
            "defectKind": "preview_omits_final_answer",
            "rationale": (
                "Sample only has rawPredictionPreview (≥800 chars) without an ANSWER "
                "marker. Reload full rawPrediction from item-results before calling "
                "this a grader defect."
            ),
        }

    if not expected_raw:
        return {
            **base,
            "status": "needs_expected",
            "openStageBBlocker": False,
            "defectKind": classify_defect_kind(str(raw), None),
            "rationale": "missing_expected",
        }

    expected = strip_correction_metadata(
        correct_expected(dict(expected_raw), prompt=prompt or sample.get("prompt")),
    )
    defect_kind = classify_defect_kind(str(raw), expected)
    known_fixed = {c["id"] for c in KNOWN_CORRECTED_DEFECT_CLASSES}
    truncated_flag = bool(sample.get("truncated") or historical == "truncated")
    graded = grade_model_output(
        str(raw),
        expected,
        enable_thinking=enable_thinking,
        truncated=truncated_flag,
    )
    parsed = parse_model_output(
        str(raw),
        enable_thinking=enable_thinking,
        truncated=truncated_flag,
    )
    completeness = is_incomplete_response(sample, raw=str(raw), parsed=parsed)

    if completeness["incomplete"]:
        return {
            **base,
            "status": "incomplete_or_truncated_response",
            "openStageBBlocker": False,
            "defectKind": defect_kind,
            "knownCorrectedClass": False,
            "currentOutcome": graded.get("outcome"),
            "currentCorrect": bool(graded.get("correct")),
            "formatCompliant": graded.get("formatCompliant"),
            "parseOk": bool(parsed.get("ok")),
            "parsedMathText": parsed.get("mathText") or parsed.get("answer"),
            "expectedUsed": expected,
            "completeness": completeness,
            "rationale": (
                "Response lacks a usable final answer (truncated/incomplete). "
                "Not a grader defect; not a Stage B blocker."
            ),
        }

    now_correct = graded.get("outcome") == "correct"
    if now_correct:
        status = "historical_corrected"
        open_blocker = False
        rationale = "current_grader_marks_correct"
    else:
        status = "remaining_defect"
        open_blocker = True
        rationale = "complete_response_still_not_correct_under_current_grader"
        if defect_kind in known_fixed:
            status = "remaining_defect_unexpected_for_known_class"

    return {
        **base,
        "status": status,
        "openStageBBlocker": open_blocker,
        "defectKind": defect_kind,
        "knownCorrectedClass": defect_kind in known_fixed,
        "currentOutcome": graded.get("outcome"),
        "currentCorrect": bool(graded.get("correct")),
        "formatCompliant": graded.get("formatCompliant"),
        "parseOk": bool(parsed.get("ok")),
        "parsedMathText": parsed.get("mathText") or parsed.get("answer"),
        "expectedUsed": expected,
        "completeness": completeness,
        "rationale": rationale,
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
    incomplete = sum(1 for r in reconciled if r["status"] == "incomplete_or_truncated_response")
    needs_full = sum(1 for r in reconciled if r["status"] == "needs_full_raw")
    remaining = sum(1 for r in reconciled if str(r["status"]).startswith("remaining_defect"))
    needs = sum(
        1
        for r in reconciled
        if r["status"] in {"needs_raw_output", "needs_expected"}
    )
    by_kind: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for r in reconciled:
        k = str(r.get("defectKind") or "unknown")
        by_kind[k] = by_kind.get(k, 0) + 1
        by_status[str(r["status"])] = by_status.get(str(r["status"]), 0) + 1

    return {
        "ok": True,
        "reconcileVersion": RECONCILE_VERSION,
        "reconcileVersionSupersedes": RECONCILE_VERSION_PREVIOUS,
        "graderVersion": GRADER_VERSION,
        "expectedCorrectionVersion": EXPECTED_CORRECTION_VERSION,
        "knownCorrectedDefectClasses": KNOWN_CORRECTED_DEFECT_CLASSES,
        "inputMissCount": len(misses),
        "historicalCorrectedCount": hist,
        "incompleteOrTruncatedCount": incomplete,
        "needsFullRawCount": needs_full,
        "remainingDefectCount": remaining,
        "needsMoreEvidenceCount": needs,
        "openStageBBlockerCount": sum(1 for r in reconciled if r.get("openStageBBlocker")),
        "byStatus": by_status,
        "byDefectKind": by_kind,
        "samples": reconciled,
        "policy": (
            "historical_corrected and incomplete_or_truncated_response are not open "
            "Stage B blockers. remaining_defect (complete response, still wrong under "
            "current grader) requires a versioned grader/expected fix before Stage B. "
            "Never treat truncation/incomplete output as a grader defect without evidence "
            "of a usable final answer. LLM judgments never authorize promotion."
        ),
        "sourceAuditVersion": weak_audit.get("auditVersion"),
        "lockedDataAccessed": False,
    }


def poly_0042_incomplete_fixture_sample() -> dict[str, Any]:
    """Canonical incomplete response for the preflight item (no final ANSWER).

    Mirrors a truncated/incomplete generation: algebraic working without a
    closing ANSWER line. Expected roots preserved from gen-v2 development item.
    """
    return {
        "itemId": POLY_0042_ITEM_ID,
        "family": "polynomial_factorization",
        "difficulty": "hard",
        "outcome": "truncated",
        "truncated": True,
        "classification": "grader_miss",  # historical mislabel under reconcile v1
        "rationale": "historical_audit_labeled_miss_without_final_answer",
        "rawPrediction": (
            "We factor p(x) = x**3 - 22*x**2 - 215*x + 5100.\n"
            "Possible rational roots are factors of 5100 over 1.\n"
            "Testing x=20: 8000 - 8800 - 4300 + 5100 = 0, so (x-20) is a factor.\n"
            "Dividing leaves a quadratic; continuing the factoriza"
        ),
        "expected": {
            "kind": "roots",
            "values": ["-15", "17", "20"],
            "variable": "x",
        },
        "prompt": (
            "Find all real roots of the polynomial. End with `ANSWER: <roots>` "
            "comma-separated.\n\np(x) = x**3 - 22*x**2 - 215*x + 5100"
        ),
    }


def build_synthetic_ten_miss_fixture() -> dict[str, Any]:
    """Ten synthetic grader_miss rows: 9 historically corrected + 1 incomplete.

    The 10th row is the preflight polynomial item (truncated before ANSWER) —
    not a remaining grader defect / Stage B blocker under reconcile v2.
    """
    from exact_repr import exact_pow2

    samples = [
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
        poly_0042_incomplete_fixture_sample(),
    ]
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
            "Item 0042 is incomplete/truncated (not a remaining grader defect)."
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
                "reconcileVersion": report["reconcileVersion"],
                "inputMissCount": report["inputMissCount"],
                "historicalCorrectedCount": report["historicalCorrectedCount"],
                "incompleteOrTruncatedCount": report["incompleteOrTruncatedCount"],
                "remainingDefectCount": report["remainingDefectCount"],
                "openStageBBlockerCount": report["openStageBBlockerCount"],
                "out": str(args.out),
            },
            indent=2,
        ),
    )


if __name__ == "__main__":
    main()
