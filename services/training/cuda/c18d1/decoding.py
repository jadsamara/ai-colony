#!/usr/bin/env python3
"""Decoding / thinking-mode policy for C1.8D.1 Math baselines."""

from __future__ import annotations

from typing import Any

# Qwen3 thinking-mode guidance: use sampling (not greedy) when thinking is enabled.
THINKING_DISABLED = {
    "id": "thinking_disabled_greedy",
    "enableThinking": False,
    "doSample": False,
    "temperature": 0.0,
    "topP": None,
    "topK": None,
    "maxNewTokens": 512,
    "primaryMetric": "accuracy",
    "samplesPerProblem": 1,
}

THINKING_ENABLED = {
    "id": "thinking_enabled_qwen3_sample",
    "enableThinking": True,
    "doSample": True,
    # Documented-style Qwen3 thinking sampling defaults (record exactly in manifests).
    "temperature": 0.6,
    "topP": 0.95,
    "topK": 20,
    "repetitionPenalty": 1.0,
    "maxNewTokens": 8192,
    "primaryMetric": "pass_at_1",
    "secondaryMetric": "pass_at_3",
    "samplesPerProblem": 3,
    "pilotMaxNewTokens": 8192,
    "note": (
        "Preferred primary Math mode when the department normally uses Qwen3 thinking. "
        "Do not substitute pass@3 for pass@1 when claiming improvement."
    ),
}

FEW_SHOT_THINKING = {
    **THINKING_ENABLED,
    "id": "thinking_enabled_few_shot",
    "promptCondition": "few_shot_dev_selected",
}

CONDITIONS = {
    "thinking_disabled_zero_shot": THINKING_DISABLED,
    "thinking_enabled_zero_shot": THINKING_ENABLED,
    "thinking_enabled_few_shot": FEW_SHOT_THINKING,
}


def sampling_seed_schedule(base_seed: int, item_index: int, sample_index: int) -> int:
    """Predefined seed schedule for matched base/adapter stochastic comparisons."""
    return (base_seed * 1_000_003 + item_index * 97 + sample_index * 13) % (2**31 - 1)


def matched_job_fields(condition: dict[str, Any]) -> dict[str, Any]:
    return {
        "enableThinking": condition["enableThinking"],
        "doSample": condition["doSample"],
        "temperature": condition.get("temperature"),
        "topP": condition.get("topP"),
        "topK": condition.get("topK"),
        "repetitionPenalty": condition.get("repetitionPenalty"),
        "maxNewTokens": condition["maxNewTokens"],
        "samplesPerProblem": condition.get("samplesPerProblem", 1),
    }
