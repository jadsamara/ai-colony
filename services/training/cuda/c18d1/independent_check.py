#!/usr/bin/env python3
"""Independent mathematical checks for weak-family / disagreement audits.

These helpers intentionally avoid treating ``grade_model_output`` outcomes as
ground truth. A response is a genuine math error only when an independently
extracted candidate is successfully compared and proven unequal to the
expected value. Grader outcomes alone never imply genuine_math_error.
"""

from __future__ import annotations

from typing import Any

from answer_parser import parse_model_output
from exact_repr import correct_expected, strip_correction_metadata
from sympy_grader import answers_canonically_equal, grade_answer


def extract_candidate(
    raw: str,
    *,
    enable_thinking: bool,
    truncated: bool = False,
) -> dict[str, Any]:
    """Extract a final-answer candidate without grading correctness."""
    parsed = parse_model_output(raw, enable_thinking=enable_thinking, truncated=truncated)
    if not parsed.get("ok"):
        return {
            "ok": False,
            "mathText": None,
            "parseStatus": parsed.get("parseStatus") or parsed.get("outcomeClass"),
            "reason": parsed.get("reason"),
            "formatCompliant": bool(parsed.get("formatCompliant")),
            "parsed": parsed,
        }
    math_text = parsed.get("mathText") or parsed.get("answer")
    return {
        "ok": True,
        "mathText": math_text,
        "parseStatus": "ok",
        "reason": None,
        "formatCompliant": bool(parsed.get("formatCompliant")),
        "parsed": parsed,
    }


def independent_equals(
    candidate: str | None,
    expected: dict[str, Any],
    *,
    prompt: str | None = None,
) -> dict[str, Any]:
    """Compare candidate to (possibly exact-corrected) expected via SymPy.

    Returns comparable=True only when both sides are usable for a decisive check.
    """
    if candidate is None or not str(candidate).strip():
        return {
            "equal": False,
            "comparable": False,
            "reason": "missing_candidate",
            "expectedUsed": expected,
        }
    expected_use = strip_correction_metadata(correct_expected(expected, prompt=prompt))
    try:
        grade = grade_answer(str(candidate).strip(), expected_use)
    except Exception as exc:  # noqa: BLE001
        return {
            "equal": False,
            "comparable": False,
            "reason": f"compare_exception:{type(exc).__name__}",
            "expectedUsed": expected_use,
        }
    if grade.get("detail") in {
        "unparseable_roots",
        "unparseable_expression",
        "unparseable_interval",
        "unparseable_relation",
        "interval_format",
        "unsupported",
    }:
        # Fall back to canonical key equality for opaque forms.
        render = _expected_render(expected_use)
        if render is None:
            return {
                "equal": False,
                "comparable": False,
                "reason": f"unparseable:{grade.get('detail')}",
                "expectedUsed": expected_use,
                "gradeDetail": grade.get("detail"),
            }
        eq = answers_canonically_equal(str(candidate), render)
        return {
            "equal": bool(eq.get("equal")),
            "comparable": eq.get("keyA", {}).get("ok") is True and eq.get("keyB", {}).get("ok") is True,
            "reason": "canonical_fallback",
            "expectedUsed": expected_use,
            "gradeDetail": grade.get("detail"),
        }
    return {
        "equal": bool(grade.get("correct")),
        "comparable": True,
        "reason": "sympy_grade_answer",
        "expectedUsed": expected_use,
        "gradeDetail": grade.get("detail"),
    }


def _expected_render(expected: dict[str, Any]) -> str | None:
    kind = expected.get("kind")
    if kind == "roots":
        return ", ".join(str(v) for v in expected.get("values") or [])
    if kind == "no_solution":
        return "no solution"
    if kind == "all_reals":
        return "all real numbers"
    if kind == "expression":
        return str(expected.get("value"))
    if kind == "interval":
        lo = "(" if expected.get("leftOpen") else "["
        ro = ")" if expected.get("rightOpen") else "]"
        return f"{lo}{expected.get('left')}, {expected.get('right')}{ro}"
    return None


def classify_independently(
    row: dict[str, Any],
    expected: dict[str, Any],
    *,
    enable_thinking: bool,
    prompt: str | None = None,
) -> dict[str, Any]:
    """Classify a failure without trusting the audited grader's wrong label."""
    raw = str(row.get("rawPrediction") or "")
    historical = str(row.get("outcome") or "")
    extracted = extract_candidate(
        raw,
        enable_thinking=enable_thinking,
        truncated=bool(row.get("truncated")),
    )
    if not extracted["ok"] or not extracted.get("mathText"):
        # Missing/invalid marker is insufficient / incomplete — not a grader miss.
        # Truncated or grader_error-without-answer must never become grader_miss
        # without evidence of a usable final answer the grader failed to extract.
        rationale = extracted.get("reason") or "no_extractable_answer"
        if bool(row.get("truncated")) or historical == "truncated":
            rationale = "truncated_before_final_answer"
        elif historical == "grader_error":
            rationale = "grader_error_without_extractable_answer"
        return {
            "classification": "insufficient_response",
            "rationale": rationale,
            "parsedAnswer": extracted.get("mathText"),
            "independentEqual": None,
            "comparable": False,
            "formatCompliant": extracted.get("formatCompliant"),
            "historicalOutcome": historical,
        }

    check = independent_equals(extracted["mathText"], expected, prompt=prompt)
    if check.get("equal") and check.get("comparable"):
        return {
            "classification": "grader_miss",
            "rationale": "independent_check_marks_equal",
            "parsedAnswer": extracted["mathText"],
            "independentEqual": True,
            "comparable": True,
            "formatCompliant": extracted.get("formatCompliant"),
            "historicalOutcome": historical,
            "expectedUsed": check.get("expectedUsed"),
        }
    if check.get("comparable") and check.get("equal") is False:
        return {
            "classification": "genuine_math_error",
            "rationale": "independent_check_marks_unequal",
            "parsedAnswer": extracted["mathText"],
            "independentEqual": False,
            "comparable": True,
            "formatCompliant": extracted.get("formatCompliant"),
            "historicalOutcome": historical,
            "expectedUsed": check.get("expectedUsed"),
        }
    return {
        "classification": "needs_human_review",
        "rationale": check.get("reason") or "not_independently_comparable",
        "parsedAnswer": extracted["mathText"],
        "independentEqual": None,
        "comparable": False,
        "formatCompliant": extracted.get("formatCompliant"),
        "historicalOutcome": historical,
        "expectedUsed": check.get("expectedUsed"),
    }
