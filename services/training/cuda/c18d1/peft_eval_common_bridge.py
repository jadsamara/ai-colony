#!/usr/bin/env python3
"""Conservative accounting helpers for C1.8D.1 (local copy of Phase 0 bounds)."""

from __future__ import annotations

from typing import Any


def conservative_from_outcomes(outcomes: list[str]) -> dict[str, Any]:
    total = len(outcomes)
    correct = sum(1 for o in outcomes if o == "correct")
    wrong = sum(1 for o in outcomes if o == "wrong")
    invalid = sum(1 for o in outcomes if o == "invalid")
    truncated = sum(1 for o in outcomes if o == "truncated")
    # Truncated is a distinct class; do not also count as invalid in totals.
    # Ensure partition: correct+wrong+invalid+truncated == total when outcomes are exclusive.
    observed = (correct / total) if total else 0.0
    lower = (correct / total) if total else 0.0
    upper = ((correct + invalid + truncated) / total) if total else 0.0
    return {
        "sampleSize": total,
        "correct": correct,
        "wrong": wrong,
        "invalid": invalid,
        "truncated": truncated,
        "observedAccuracy": observed,
        "lowerBoundAccuracy": lower,
        "upperBoundAccuracy": upper,
        "countsConsistent": correct + wrong + invalid + truncated == total,
    }


def conservative_improvement(base: dict[str, Any], adapter: dict[str, Any]) -> dict[str, Any]:
    return {
        "baseUpperBoundAccuracy": base["upperBoundAccuracy"],
        "adapterLowerBoundAccuracy": adapter["lowerBoundAccuracy"],
        "conservativeImprovement": adapter["lowerBoundAccuracy"] - base["upperBoundAccuracy"],
        "observedImprovement": adapter["observedAccuracy"] - base["observedAccuracy"],
    }
