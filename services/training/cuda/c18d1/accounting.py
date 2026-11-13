#!/usr/bin/env python3
"""Per-sample accounting and family × difficulty summaries for C1.8D.1.

Sampled conditions:
- sampleSize = itemCount × samplesPerProblem
- pass@1 = mean correctness over **all samples** (not first-sample-only)
- Per-item and per-sample counts are reported separately

Mathematical correctness is distinct from format compliance.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

ACCOUNTING_VERSION = "c18d1-accounting-v2"


def _final_text_for_diagnostics(parsed: dict[str, Any] | None, raw: str) -> str:
    """Prefer post-</think> final region for invalid-sample diagnostics."""
    if parsed and parsed.get("finalText") is not None:
        return str(parsed.get("finalText") or "")
    text = raw or ""
    if "</think>" in text:
        return text.rsplit("</think>", 1)[1]
    return text


def summarize_sample_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "itemId": row.get("itemId"),
        "family": row.get("family"),
        "difficulty": row.get("difficulty"),
        "sampleIndex": row.get("sampleIndex"),
        "outcome": row.get("outcome"),
        "correct": bool(row.get("correct")),
        "mathematicalCorrect": bool(row.get("mathematicalCorrect", row.get("correct"))),
        "formatCompliant": bool(row.get("formatCompliant")),
        "truncated": bool(row.get("truncated")),
        "thinkingProtocolViolation": bool(row.get("thinkingProtocolViolation")),
        "generatedTokens": row.get("generatedTokens"),
        "runtimeMs": row.get("runtimeMs"),
        "invalidReason": row.get("invalidReason"),
    }


def build_accounting(results: list[dict[str, Any]], *, samples_per_problem: int) -> dict[str, Any]:
    """Aggregate per-sample and per-item metrics from item-level result rows."""
    by_item: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in results:
        by_item[str(row["itemId"])].append(row)

    sample_size = len(results)
    item_count = len(by_item)
    expected_samples = item_count * int(samples_per_problem) if item_count else 0

    correct_samples = sum(1 for r in results if r.get("outcome") == "correct")
    wrong_samples = sum(1 for r in results if r.get("outcome") == "wrong")
    invalid_samples = sum(1 for r in results if r.get("outcome") == "invalid")
    truncated_samples = sum(1 for r in results if r.get("outcome") == "truncated")
    format_ok_samples = sum(1 for r in results if r.get("formatCompliant"))
    math_ok_samples = sum(1 for r in results if r.get("mathematicalCorrect") or r.get("correct"))

    # pass@1 = mean over all samples
    pass_at_1 = (correct_samples / sample_size) if sample_size else 0.0

    # Per-item: any-of / first-sample retained as secondary diagnostics
    per_item: list[dict[str, Any]] = []
    items_any_correct = 0
    items_first_correct = 0
    for item_id, rows in sorted(by_item.items()):
        rows = sorted(rows, key=lambda r: int(r.get("sampleIndex") or 0))
        first = rows[0]
        any_ok = any(bool(r.get("correct")) for r in rows)
        if any_ok:
            items_any_correct += 1
        if first.get("correct"):
            items_first_correct += 1
        per_item.append(
            {
                "itemId": item_id,
                "family": first.get("family"),
                "difficulty": first.get("difficulty"),
                "sampleCount": len(rows),
                "anyCorrect": any_ok,
                "firstSampleCorrect": bool(first.get("correct")),
                "outcomes": [r.get("outcome") for r in rows],
            },
        )

    # Family × difficulty
    cell: dict[tuple[str, str], dict[str, Any]] = {}
    for row in results:
        key = (str(row.get("family") or "unknown"), str(row.get("difficulty") or "unknown"))
        bucket = cell.setdefault(
            key,
            {
                "family": key[0],
                "difficulty": key[1],
                "samples": 0,
                "correct": 0,
                "wrong": 0,
                "invalid": 0,
                "truncated": 0,
                "formatCompliant": 0,
                "generatedTokensSum": 0,
                "generatedTokensCount": 0,
                "runtimeMsSum": 0.0,
                "runtimeMsCount": 0,
            },
        )
        bucket["samples"] += 1
        outcome = row.get("outcome")
        if outcome in bucket:
            bucket[outcome] += 1
        if row.get("formatCompliant"):
            bucket["formatCompliant"] += 1
        if row.get("generatedTokens") is not None:
            bucket["generatedTokensSum"] += int(row["generatedTokens"])
            bucket["generatedTokensCount"] += 1
        if row.get("runtimeMs") is not None:
            bucket["runtimeMsSum"] += float(row["runtimeMs"])
            bucket["runtimeMsCount"] += 1

    family_difficulty = []
    for key in sorted(cell.keys()):
        bucket = cell[key]
        n = bucket["samples"] or 1
        family_difficulty.append(
            {
                **{k: bucket[k] for k in (
                    "family", "difficulty", "samples", "correct", "wrong", "invalid",
                    "truncated", "formatCompliant",
                )},
                "mathematicalAccuracy": bucket["correct"] / n,
                "formatComplianceRate": bucket["formatCompliant"] / n,
                "meanGeneratedTokens": (
                    bucket["generatedTokensSum"] / bucket["generatedTokensCount"]
                    if bucket["generatedTokensCount"]
                    else None
                ),
                "meanRuntimeMs": (
                    bucket["runtimeMsSum"] / bucket["runtimeMsCount"]
                    if bucket["runtimeMsCount"]
                    else None
                ),
            },
        )

    invalid_diagnostics = []
    for row in results:
        if row.get("outcome") != "invalid":
            continue
        parsed = row.get("parsed") or {}
        invalid_diagnostics.append(
            {
                "itemId": row.get("itemId"),
                "sampleIndex": row.get("sampleIndex"),
                "family": row.get("family"),
                "difficulty": row.get("difficulty"),
                "invalidReason": row.get("invalidReason") or parsed.get("reason"),
                "finalResponseAfterThink": _final_text_for_diagnostics(
                    parsed if isinstance(parsed, dict) else None,
                    str(row.get("rawPrediction") or ""),
                )[:2000],
            },
        )

    token_vals = [int(r["generatedTokens"]) for r in results if r.get("generatedTokens") is not None]
    runtime_vals = [float(r["runtimeMs"]) for r in results if r.get("runtimeMs") is not None]

    return {
        "accountingVersion": ACCOUNTING_VERSION,
        "sampleSize": sample_size,
        "itemCount": item_count,
        "samplesPerProblem": int(samples_per_problem),
        "expectedSampleSize": expected_samples,
        "sampleSizeMatchesExpected": sample_size == expected_samples,
        "passAt1": pass_at_1,
        "passAt1Definition": "mean_correctness_over_all_samples",
        "perSample": {
            "correct": correct_samples,
            "wrong": wrong_samples,
            "invalid": invalid_samples,
            "truncated": truncated_samples,
            "formatCompliant": format_ok_samples,
            "mathematicalCorrect": math_ok_samples,
            "mathematicalAccuracy": (math_ok_samples / sample_size) if sample_size else 0.0,
            "formatComplianceRate": (format_ok_samples / sample_size) if sample_size else 0.0,
            "truncationRate": (truncated_samples / sample_size) if sample_size else 0.0,
            "meanGeneratedTokens": (sum(token_vals) / len(token_vals)) if token_vals else None,
            "meanRuntimeMs": (sum(runtime_vals) / len(runtime_vals)) if runtime_vals else None,
        },
        "perItem": {
            "itemCount": item_count,
            "anySampleCorrectCount": items_any_correct,
            "firstSampleCorrectCount": items_first_correct,
            "anySampleCorrectRate": (items_any_correct / item_count) if item_count else 0.0,
            "firstSampleCorrectRate": (items_first_correct / item_count) if item_count else 0.0,
            "items": per_item,
        },
        "familyDifficulty": family_difficulty,
        "invalidSampleDiagnostics": invalid_diagnostics,
        "distinguishesMathFromFormat": True,
    }
