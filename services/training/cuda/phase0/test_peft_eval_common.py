#!/usr/bin/env python3
"""Stdlib unit checks for two-mode answer extraction (no torch required)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from peft_eval_common import (  # noqa: E402
    conservative_accuracy_bounds,
    conservative_improvement,
    score_prediction,
    summarize_scores,
)


def main() -> None:
    truncated_think = score_prediction(
        "<think>planning the rewrite",
        "[zebra]",
        enable_thinking=True,
        truncated=True,
    )
    assert truncated_think["outcome"] == "invalid"
    assert truncated_think["truncated"] is True

    finished = score_prediction(
        "<think>ok</think>\n[zebra]",
        "[zebra]",
        enable_thinking=True,
        truncated=False,
    )
    assert finished["outcome"] == "correct"
    assert finished["finalAnswer"] == "[zebra]"

    disabled_leak = score_prediction(
        "<think>should not appear</think>\n[zebra]",
        "[zebra]",
        enable_thinking=False,
        truncated=False,
    )
    assert disabled_leak["outcome"] == "invalid"

    summary = summarize_scores(
        [
            {"outcome": "invalid", "truncated": True, "invalidReason": "truncated_or_no_final_after_think"},
            {"outcome": "invalid", "truncated": True, "invalidReason": "truncated_or_no_final_after_think"},
            {"outcome": "wrong", "truncated": False},
            {"outcome": "correct", "truncated": False},
        ],
        max_base_invalid_rate=0.05,
    )
    assert summary["invalid"] == 2
    assert summary["truncatedCount"] == 2
    assert summary["evaluationValid"] is False
    assert summary["upperBoundAccuracy"] == (1 + 2) / 4
    assert summary["lowerBoundAccuracy"] == 1 / 4

    # v2.1-shaped generalization observation under v3 conservative bounds.
    bounds = conservative_improvement(
        base_correct=0,
        base_wrong=71,
        base_invalid=29,
        adapter_correct=100,
        adapter_wrong=0,
        adapter_invalid=0,
    )
    assert abs(bounds["baseUpperBoundAccuracy"] - 0.29) < 1e-12
    assert bounds["adapterLowerBoundAccuracy"] == 1.0
    assert abs(bounds["conservativeImprovement"] - 0.71) < 1e-12
    mem = conservative_accuracy_bounds(correct=8, wrong=0, invalid=0)
    assert mem["lowerBoundAccuracy"] == 1.0
    print("peft_eval_common ok")


if __name__ == "__main__":
    main()
