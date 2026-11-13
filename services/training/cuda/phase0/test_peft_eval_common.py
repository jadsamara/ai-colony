#!/usr/bin/env python3
"""Stdlib unit checks for two-mode answer extraction (no torch required)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from peft_eval_common import score_prediction, summarize_scores  # noqa: E402


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
    print("peft_eval_common ok")


if __name__ == "__main__":
    main()
