#!/usr/bin/env python3
"""Shared two-mode evaluation accounting for C1.8D (Phase 0 + later suites)."""

from __future__ import annotations

import re
from typing import Any, Literal

ThinkingMode = Literal["thinking_disabled", "thinking_enabled"]

EVAL_MODES: dict[str, dict[str, Any]] = {
    "thinking_disabled": {
        "id": "thinking_disabled",
        "enableThinking": False,
        "maxNewTokens": 64,
        "extractAfterThink": False,
    },
    "thinking_enabled": {
        "id": "thinking_enabled",
        "enableThinking": True,
        "maxNewTokens": 1024,
        "extractAfterThink": True,
    },
}


def normalize_answer(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def extract_final_answer(
    raw: str,
    *,
    enable_thinking: bool,
    truncated: bool,
) -> dict[str, Any]:
    """Split thinking traces from the final answer when required."""
    text = raw or ""
    had_think_open = "<think>" in text or text.lstrip().startswith("<think>")
    # Some decoders strip tags; also detect unfinished think by truncated + no closer.
    had_think_close = "</think>" in text

    if enable_thinking:
        if had_think_close:
            final = text.split("</think>", 1)[1].strip()
            if not final:
                return {
                    "finalAnswer": "",
                    "status": "invalid",
                    "invalidReason": "empty_after_think",
                    "hadThinkOpen": had_think_open,
                    "hadThinkClose": True,
                    "truncated": truncated,
                }
            if truncated:
                # Finished thinking but may have truncated the answer — still score if non-empty,
                # but mark truncated for metrics. Treat as invalid if clearly incomplete.
                return {
                    "finalAnswer": final,
                    "status": "valid",
                    "invalidReason": None,
                    "hadThinkOpen": True,
                    "hadThinkClose": True,
                    "truncated": True,
                }
            return {
                "finalAnswer": final,
                "status": "valid",
                "invalidReason": None,
                "hadThinkOpen": True,
                "hadThinkClose": True,
                "truncated": False,
            }
        if truncated or had_think_open or text.strip():
            return {
                "finalAnswer": "",
                "status": "invalid",
                "invalidReason": "truncated_or_no_final_after_think",
                "hadThinkOpen": had_think_open or truncated,
                "hadThinkClose": False,
                "truncated": truncated or True,
            }
        return {
            "finalAnswer": "",
            "status": "invalid",
            "invalidReason": "empty",
            "hadThinkOpen": False,
            "hadThinkClose": False,
            "truncated": truncated,
        }

    # Thinking disabled: any leftover think tags are invalid; otherwise use full text.
    if had_think_open or had_think_close:
        return {
            "finalAnswer": "",
            "status": "invalid",
            "invalidReason": "unexpected_think_with_thinking_disabled",
            "hadThinkOpen": had_think_open,
            "hadThinkClose": had_think_close,
            "truncated": truncated,
        }
    if truncated:
        return {
            "finalAnswer": text.strip(),
            "status": "invalid",
            "invalidReason": "truncated",
            "hadThinkOpen": False,
            "hadThinkClose": False,
            "truncated": True,
        }
    if not text.strip():
        return {
            "finalAnswer": "",
            "status": "invalid",
            "invalidReason": "empty",
            "hadThinkOpen": False,
            "hadThinkClose": False,
            "truncated": False,
        }
    return {
        "finalAnswer": text.strip(),
        "status": "valid",
        "invalidReason": None,
        "hadThinkOpen": False,
        "hadThinkClose": False,
        "truncated": False,
    }


def score_prediction(
    raw: str,
    expected: str,
    *,
    enable_thinking: bool,
    truncated: bool,
) -> dict[str, Any]:
    extracted = extract_final_answer(raw, enable_thinking=enable_thinking, truncated=truncated)
    if extracted["status"] != "valid":
        return {
            **extracted,
            "expected": expected,
            "outcome": "invalid",
            "exactMatch": False,
        }
    final = normalize_answer(str(extracted["finalAnswer"]))
    exp = normalize_answer(expected)
    exact = final == exp
    return {
        **extracted,
        "expected": expected,
        "outcome": "correct" if exact else "wrong",
        "exactMatch": exact,
    }


def conservative_accuracy_bounds(
    *,
    correct: int,
    wrong: int,
    invalid: int,
) -> dict[str, Any]:
    """Worst-case accuracy bounds for Phase 0 v3 comparison.

    - Upper bound treats every invalid as if it could have been correct.
    - Lower bound treats every invalid as a failure (correct / total).
    """
    total = int(correct) + int(wrong) + int(invalid)
    observed = (correct / total) if total else 0.0
    upper = ((correct + invalid) / total) if total else 0.0
    lower = (correct / total) if total else 0.0
    return {
        "total": total,
        "correct": int(correct),
        "wrong": int(wrong),
        "invalid": int(invalid),
        "countsConsistent": total == int(correct) + int(wrong) + int(invalid),
        "observedAccuracy": observed,
        "upperBoundAccuracy": upper,
        "lowerBoundAccuracy": lower,
    }


def conservative_improvement(
    *,
    base_correct: int,
    base_wrong: int,
    base_invalid: int,
    adapter_correct: int,
    adapter_wrong: int,
    adapter_invalid: int,
) -> dict[str, Any]:
    base = conservative_accuracy_bounds(
        correct=base_correct,
        wrong=base_wrong,
        invalid=base_invalid,
    )
    adapter = conservative_accuracy_bounds(
        correct=adapter_correct,
        wrong=adapter_wrong,
        invalid=adapter_invalid,
    )
    improvement = float(adapter["lowerBoundAccuracy"]) - float(base["upperBoundAccuracy"])
    return {
        "base": base,
        "adapter": adapter,
        "baseUpperBoundAccuracy": base["upperBoundAccuracy"],
        "adapterLowerBoundAccuracy": adapter["lowerBoundAccuracy"],
        "conservativeImprovement": improvement,
        "observedImprovement": float(adapter["observedAccuracy"]) - float(base["observedAccuracy"]),
    }


def summarize_scores(rows: list[dict[str, Any]], *, max_base_invalid_rate: float = 0.05) -> dict[str, Any]:
    total = len(rows)
    correct = sum(1 for row in rows if row.get("outcome") == "correct")
    wrong = sum(1 for row in rows if row.get("outcome") == "wrong")
    invalid = sum(1 for row in rows if row.get("outcome") == "invalid")
    truncated = sum(1 for row in rows if row.get("truncated"))
    no_final = sum(
        1
        for row in rows
        if row.get("invalidReason") in {
            "truncated_or_no_final_after_think",
            "empty_after_think",
            "empty",
        }
    )
    invalid_rate = (invalid / total) if total else 0.0
    # exactMatch among valid only is informative; gate uses exactMatchAllValidDenom below.
    valid = correct + wrong
    bounds = conservative_accuracy_bounds(correct=correct, wrong=wrong, invalid=invalid)
    return {
        "sampleSize": total,
        "correct": correct,
        "wrong": wrong,
        "invalid": invalid,
        "truncatedCount": truncated,
        "noFinalAnswerCount": no_final,
        "invalidRate": invalid_rate,
        "exactMatch": (correct / total) if total else 0.0,
        "exactMatchAmongValid": (correct / valid) if valid else 0.0,
        "observedAccuracy": bounds["observedAccuracy"],
        "upperBoundAccuracy": bounds["upperBoundAccuracy"],
        "lowerBoundAccuracy": bounds["lowerBoundAccuracy"],
        "evaluationValid": invalid_rate <= max_base_invalid_rate,
        "maxBaseInvalidRate": max_base_invalid_rate,
        "note": (
            "evaluationValid reflects the legacy hard invalid-rate cutoff (v2/v2.1). "
            "Phase 0 v3 gates on conservative bounds instead."
        ),
    }
