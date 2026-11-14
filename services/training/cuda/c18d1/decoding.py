#!/usr/bin/env python3
"""Decoding / thinking-mode policy for C1.8D.1 Math baselines.

``c18d1-decoding-v2``: thinking-disabled ``maxNewTokens`` raised 512 → 2048.
Historical ``c18d1-decoding-v1`` (512) is preserved for artifact interpretation
and must not be rewritten into prior reports.
"""

from __future__ import annotations

from typing import Any

DECODING_CONFIG_VERSION = "c18d1-decoding-v2"
DECODING_CONFIG_VERSION_V1 = "c18d1-decoding-v1"

# Historical thinking-disabled config (preserved; do not use for new runs).
THINKING_DISABLED_V1 = {
    "id": "thinking_disabled_greedy",
    "enableThinking": False,
    "doSample": False,
    "temperature": 0.0,
    "topP": None,
    "topK": None,
    "maxNewTokens": 512,
    "primaryMetric": "accuracy",
    "samplesPerProblem": 1,
    "decodingConfigVersion": DECODING_CONFIG_VERSION_V1,
}

# Qwen3 thinking-mode guidance: use sampling (not greedy) when thinking is enabled.
THINKING_DISABLED = {
    "id": "thinking_disabled_greedy",
    "enableThinking": False,
    "doSample": False,
    "temperature": 0.0,
    "topP": None,
    "topK": None,
    "maxNewTokens": 2048,
    "primaryMetric": "accuracy",
    "samplesPerProblem": 1,
    "decodingConfigVersion": DECODING_CONFIG_VERSION,
    "historicalMaxNewTokens": 512,
    "note": (
        "decoding-v2: maxNewTokens 2048 (was 512 under decoding-v1). "
        "Prior reports remain under their recorded decoding config."
    ),
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
    # Current frozen config remains 3 until an approved config change.
    "samplesPerProblem": 3,
    "proposedSamplesPerProblem": 4,
    "pilotMaxNewTokens": 8192,
    "decodingConfigVersion": DECODING_CONFIG_VERSION,
    "seedReproducibilityLimitation": (
        "sampling_seed_schedule(base, itemIndex, sampleIndex) is attached to each "
        "SamplingParams(seed=…), but vLLM continuous batching does not guarantee "
        "per-request seed pairing / bit-identical regeneration. Treat seeds as a "
        "matched schedule intent, not exact reproducibility."
    ),
    "note": (
        "Preferred primary Math mode when the department normally uses Qwen3 thinking. "
        "Do not substitute pass@3 for pass@1 when claiming improvement. "
        "Promotion variability reference: alternate-seed sampling floor. "
        "proposedSamplesPerProblem=4 is advisory only until decoding config is versioned."
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


def alternate_sampling_base_seed(base_seed: int) -> int:
    """Distinct base seed for sampling-variance noise floor (thinking mode).

    Base-vs-adapter comparisons still use the same primary schedule; this
    alternate is only for measuring sampling variance between schedules.
    """
    return (int(base_seed) + 1_000_003) % (2**31 - 1)


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
        "decodingConfigVersion": condition.get("decodingConfigVersion", DECODING_CONFIG_VERSION),
    }
