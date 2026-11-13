#!/usr/bin/env python3
"""Batch-invariance metrics and pass criteria (CPU-testable helpers).

Exact generated-text equality is reported but not required for the gate.
"""

from __future__ import annotations

from typing import Any

# Absolute max |Δlogit| on the first generated-token distribution.
# bfloat16 machine epsilon is 2^-7 ≈ 7.8e-3; matmul/softmax accumulation under
# different batch GEMM shapes routinely produces O(1e-2) abs shifts on near-ties.
# Gate tolerance: 5e-2 (stated bf16 noise band for this Stage A check).
BF16_FIRST_TOKEN_LOGIT_ABS_TOL = 5e-2

PREFIX_ARTIFACT_MARKERS = (
    "</think>",
    "<think>",
    "<|im_start|>",
    "<|im_end|>",
    "assistant\n",
    "assistant ",
)

GATE_VERSION = "c18d1-batch-invariance-v2"


def expected_left_pad_position_ids(attention_mask_row: list[int]) -> list[int]:
    """Position ids for one left-padded row: pads → 0, content → 0..L-1 contiguous.

    Matches the usual Transformers cumsum(mask)-1 pattern with pads forced to 0.
    The content span must equal the unpadded run's [0, 1, ..., L-1].
    """
    positions: list[int] = []
    content_pos = 0
    for bit in attention_mask_row:
        if int(bit) == 0:
            positions.append(0)
        else:
            positions.append(content_pos)
            content_pos += 1
    return positions


def content_position_ids(attention_mask_row: list[int], position_ids_row: list[int]) -> list[int]:
    """Return position ids restricted to attended (non-pad) tokens."""
    return [int(p) for bit, p in zip(attention_mask_row, position_ids_row) if int(bit) == 1]


def position_ids_aligned_with_unpadded(
    *,
    unpadded_attention_mask: list[int],
    unpadded_position_ids: list[int],
    padded_attention_mask: list[int],
    padded_position_ids: list[int],
) -> dict[str, Any]:
    """Verify padded content positions match the unpadded run."""
    expected_unpadded = expected_left_pad_position_ids(unpadded_attention_mask)
    expected_padded = expected_left_pad_position_ids(padded_attention_mask)
    unpadded_content = content_position_ids(unpadded_attention_mask, unpadded_position_ids)
    padded_content = content_position_ids(padded_attention_mask, padded_position_ids)
    expected_content = list(range(sum(int(b) for b in unpadded_attention_mask)))
    ok = (
        unpadded_content == expected_content
        and padded_content == expected_content
        and unpadded_position_ids == expected_unpadded
        and padded_position_ids == expected_padded
        and unpadded_content == padded_content
    )
    return {
        "aligned": ok,
        "unpaddedContent": unpadded_content,
        "paddedContent": padded_content,
        "expectedContent": expected_content,
    }


def detect_prefix_artifacts(text: str, *, enable_thinking: bool = False) -> list[str]:
    """Flag prompt/template leakage at the start of decoded generations."""
    raw = text or ""
    hits: list[str] = []
    stripped = raw.lstrip()
    if not enable_thinking:
        for marker in ("</think>", "<think>"):
            if marker in raw:
                hits.append(marker)
    for marker in ("<|im_start|>", "<|im_end|>"):
        if marker in raw:
            hits.append(marker)
    # Role artifact only if it leads the generation (not mid-reasoning mention).
    lower = stripped[:32].lower()
    if lower.startswith("assistant"):
        hits.append("assistant_role_prefix")
    return hits


def outcomes_agree(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Graded outcomes agree when outcome class and math answer text match."""
    if a.get("outcome") != b.get("outcome"):
        return False
    # For correct/wrong, require same extracted math text when both parsed.
    math_a = a.get("mathText")
    math_b = b.get("mathText")
    if a.get("outcome") in {"correct", "wrong"}:
        return math_a == math_b
    # invalid/truncated: same outcome is enough; reasons may differ on wording
    return True


def gate_pass(
    *,
    prefix_artifact_count: int,
    position_ids_ok: bool,
    outcome_disagreements: int,
    first_token_logit_max_abs: float | None,
    logit_tol: float = BF16_FIRST_TOKEN_LOGIT_ABS_TOL,
) -> dict[str, Any]:
    logits_ok = first_token_logit_max_abs is not None and float(first_token_logit_max_abs) <= float(logit_tol)
    passed = (
        prefix_artifact_count == 0
        and position_ids_ok
        and outcome_disagreements == 0
        and logits_ok
    )
    return {
        "passed": passed,
        "checks": {
            "noPrefixTemplateArtifacts": prefix_artifact_count == 0,
            "positionIdsAligned": position_ids_ok,
            "gradedOutcomeAgreement": outcome_disagreements == 0,
            "firstTokenLogitsWithinBf16Noise": logits_ok,
        },
        "bf16FirstTokenLogitAbsTol": logit_tol,
        "exactTextMatchRequired": False,
    }
