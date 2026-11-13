#!/usr/bin/env python3
"""C1.8D statistical evaluation gate (versioned; does not overwrite historical gates).

Adopted after greedy exact-repeatability proved unsuitable for vLLM continuous
batching. Historical Gate v2/v3 and vLLM repeatability reports remain unchanged.
"""

from __future__ import annotations

from typing import Any

from generation_utils import PRIMARY_EVAL_BACKEND, REFERENCE_BACKEND, STATISTICAL_GATE_VERSION
from paired_stats import STAT_METHODS_VERSION

GATE_VERSION = STATISTICAL_GATE_VERSION
GATE_ADOPTED_REASON = (
    "Exact greedy same-config repeatability is not the acceptance criterion for "
    "vLLM continuous batching. Gate v1 uses measured noise floor, flip rates, "
    "paired statistics, and cross-backend agreement within tolerance."
)


def gate_pass_statistical_v1(
    *,
    artifacts_clear: bool,
    noise_floor_recorded: bool,
    flip_rates_reported: bool,
    cross_backend_pass: bool,
    unresolved_alignment_artifacts: bool = False,
) -> dict[str, Any]:
    """Primary-backend eligibility under statistical gate v1."""
    blockers: list[str] = []
    if not artifacts_clear or unresolved_alignment_artifacts:
        blockers.append("unresolved_prompt_prefix_caching_extraction_or_alignment_artifacts")
    if not flip_rates_reported:
        blockers.append("identical_run_flip_rates_not_reported")
    if not noise_floor_recorded:
        blockers.append("baseline_noise_floor_or_uncertainty_not_recorded")
    if not cross_backend_pass:
        blockers.append("cross_backend_agreement_failed_or_missing")
    passed = len(blockers) == 0
    return {
        "gateVersion": GATE_VERSION,
        "methodsVersion": STAT_METHODS_VERSION,
        "passed": passed,
        "primaryBackend": PRIMARY_EVAL_BACKEND,
        "referenceBackend": REFERENCE_BACKEND,
        "blockers": blockers,
        "adoptedReason": GATE_ADOPTED_REASON,
        "criteria": {
            "artifactsClear": artifacts_clear,
            "flipRatesReported": flip_rates_reported,
            "noiseFloorRecorded": noise_floor_recorded,
            "crossBackendPass": cross_backend_pass,
        },
        "note": (
            "Historical exact-repeatability reports are preserved and not rewritten. "
            "Do not override a failed gate."
        ),
    }


def adapter_claim_gate(
    *,
    statistical_gate_passed: bool,
    improvement_decision: dict[str, Any],
    same_session_base_adapter: bool,
    samples_per_item_thinking: int,
    min_samples_thinking: int = 3,
) -> dict[str, Any]:
    blockers: list[str] = []
    if not statistical_gate_passed:
        blockers.append("statistical_gate_not_passed")
    if not same_session_base_adapter:
        blockers.append("base_and_adapter_not_same_session_backend")
    if samples_per_item_thinking < min_samples_thinking:
        blockers.append(f"thinking_samples_per_item<{min_samples_thinking}")
    if improvement_decision.get("decision") != "improve":
        blockers.append("improvement_inconclusive_or_below_mdi")
    passed = len(blockers) == 0
    return {
        "gateVersion": GATE_VERSION,
        "passed": passed,
        "promoteEligible": passed,
        "blockers": blockers,
        "improvementDecision": improvement_decision.get("decision"),
        "note": "Do not promote adapters when improvement is inconclusive.",
    }
