#!/usr/bin/env python3
"""Paired statistics for C1.8D statistical evaluation gate (CPU-testable).

Mirrors packages/core/src/evaluation/stats.ts (Wilson, McNemar, paired counts).
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Sequence


STAT_METHODS_VERSION = "c18d1-paired-stats-v1"
DEFAULT_Z = 1.96
DEFAULT_ALPHA = 0.05


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def wilson_interval(successes: int, sample_size: int, z: float = DEFAULT_Z) -> dict[str, float]:
    if sample_size <= 0:
        return {"low": 0.0, "high": 1.0, "z": float(z)}
    proportion = successes / sample_size
    z2 = z * z
    denom = 1.0 + z2 / sample_size
    center = (proportion + z2 / (2.0 * sample_size)) / denom
    margin = (
        z
        * math.sqrt((proportion * (1.0 - proportion) + z2 / (4.0 * sample_size)) / sample_size)
        / denom
    )
    return {"low": clamp01(center - margin), "high": clamp01(center + margin), "z": float(z)}


def _binomial(n: int, k: int) -> float:
    value = 1.0
    for index in range(1, k + 1):
        value = (value * (n - k + index)) / index
    return value


def mcnemar_exact(baseline_only: int, candidate_only: int) -> float:
    """Exact two-sided McNemar p-value from discordant pair counts."""
    discordant = int(baseline_only) + int(candidate_only)
    if discordant == 0:
        return 1.0
    smaller = min(int(baseline_only), int(candidate_only))
    tail = 0.0
    for index in range(smaller + 1):
        tail += _binomial(discordant, index)
    return min(1.0, (2.0 * tail) / (2**discordant))


def paired_counts(baseline_correct: Sequence[bool], candidate_correct: Sequence[bool]) -> dict[str, Any]:
    if len(baseline_correct) != len(candidate_correct) or not baseline_correct:
        raise ValueError("paired comparison requires equal non-empty outcome lists")
    both = base_only = cand_only = neither = 0
    for b, c in zip(baseline_correct, candidate_correct):
        if b and c:
            both += 1
        elif b:
            base_only += 1
        elif c:
            cand_only += 1
        else:
            neither += 1
    n = len(baseline_correct)
    return {
        "sampleSize": n,
        "bothCorrect": both,
        "baselineOnly": base_only,
        "candidateOnly": cand_only,
        "neitherCorrect": neither,
        "baselineAccuracy": (both + base_only) / n,
        "candidateAccuracy": (both + cand_only) / n,
        "difference": (cand_only - base_only) / n,
        "mcnemarPValue": mcnemar_exact(base_only, cand_only),
        "differenceWilson": wilson_interval(cand_only, base_only + cand_only)
        if (base_only + cand_only) > 0
        else {"low": 0.0, "high": 0.0, "z": DEFAULT_Z, "note": "no_discordant_pairs"},
    }


def accuracy_rate(correct_flags: Sequence[bool]) -> float:
    if not correct_flags:
        return 0.0
    return sum(1 for x in correct_flags if x) / len(correct_flags)


def graded_outcome_flip_rate(outcomes_a: Sequence[str], outcomes_b: Sequence[str]) -> dict[str, Any]:
    if len(outcomes_a) != len(outcomes_b) or not outcomes_a:
        raise ValueError("flip rate requires equal non-empty outcome lists")
    flips = sum(1 for a, b in zip(outcomes_a, outcomes_b) if a != b)
    n = len(outcomes_a)
    return {
        "sampleSize": n,
        "flipCount": flips,
        "flipRate": flips / n,
        "flipRateWilson": wilson_interval(flips, n),
    }


def per_family_accuracy(
    rows: Sequence[dict[str, Any]],
    *,
    family_key: str = "family",
    correct_key: str = "correct",
) -> dict[str, dict[str, Any]]:
    buckets: dict[str, list[bool]] = defaultdict(list)
    for row in rows:
        buckets[str(row.get(family_key) or "unknown")].append(bool(row.get(correct_key)))
    out: dict[str, dict[str, Any]] = {}
    for family, flags in sorted(buckets.items()):
        correct = sum(1 for f in flags if f)
        n = len(flags)
        out[family] = {
            "sampleSize": n,
            "correct": correct,
            "accuracy": (correct / n) if n else 0.0,
            "wilson": wilson_interval(correct, n),
        }
    return out


def compare_identical_runs(
    rows_a: Sequence[dict[str, Any]],
    rows_b: Sequence[dict[str, Any]],
    *,
    id_key: str = "itemId",
    sample_key: str = "sampleIndex",
) -> dict[str, Any]:
    """Noise-floor comparison of two identical-config evaluation result lists."""
    def _index(rows: Sequence[dict[str, Any]]) -> dict[tuple[str, int], dict[str, Any]]:
        return {(str(r[id_key]), int(r.get(sample_key) or 0)): r for r in rows}

    ia, ib = _index(rows_a), _index(rows_b)
    keys = sorted(set(ia) & set(ib))
    if not keys:
        raise ValueError("no overlapping item/sample keys between identical runs")
    correct_a = [bool(ia[k].get("correct")) for k in keys]
    correct_b = [bool(ib[k].get("correct")) for k in keys]
    outcomes_a = [str(ia[k].get("outcome") or "") for k in keys]
    outcomes_b = [str(ib[k].get("outcome") or "") for k in keys]
    paired = paired_counts(correct_a, correct_b)
    flips = graded_outcome_flip_rate(outcomes_a, outcomes_b)
    # Absolute accuracy difference (not evidence of zero noise when == 0)
    acc_a = accuracy_rate(correct_a)
    acc_b = accuracy_rate(correct_b)
    abs_diff = abs(acc_a - acc_b)
    # Per-family
    fam_rows_a = [{"family": ia[k].get("family"), "correct": ia[k].get("correct")} for k in keys]
    fam_rows_b = [{"family": ib[k].get("family"), "correct": ib[k].get("correct")} for k in keys]
    fam_a = per_family_accuracy(fam_rows_a)
    fam_b = per_family_accuracy(fam_rows_b)
    fam_diff: dict[str, Any] = {}
    for family in sorted(set(fam_a) | set(fam_b)):
        a = fam_a.get(family, {"accuracy": 0.0, "sampleSize": 0})
        b = fam_b.get(family, {"accuracy": 0.0, "sampleSize": 0})
        fam_diff[family] = {
            "accuracyA": a["accuracy"],
            "accuracyB": b["accuracy"],
            "absoluteDifference": abs(a["accuracy"] - b["accuracy"]),
            "sampleSizeA": a["sampleSize"],
            "sampleSizeB": b["sampleSize"],
        }
    return {
        "methodsVersion": STAT_METHODS_VERSION,
        "pairedSampleSize": len(keys),
        "accuracyA": acc_a,
        "accuracyB": acc_b,
        "absoluteAccuracyDifference": abs_diff,
        "paired": paired,
        "gradedOutcomeFlips": flips,
        "perFamily": {"runA": fam_a, "runB": fam_b, "differences": fam_diff},
        "note": (
            "Identical aggregate accuracies are not evidence of zero noise. "
            "Use flip rates, paired differences, and CIs."
        ),
    }


def minimum_detectable_improvement(
    *,
    noise_abs_accuracy_diff: float,
    flip_rate: float,
    sample_size: int,
    power: float = 0.8,
    alpha: float = DEFAULT_ALPHA,
) -> dict[str, Any]:
    """Documented MDI for adapter claims (conservative heuristic + assumptions).

    Assumptions (recorded with the estimate):
    - Noise floor estimated from identical-run absolute accuracy difference and
      graded-outcome flip rate on the same development set / condition.
    - McNemar-style paired tests will be used for adapter claims.
    - MDI is at least max(measured abs accuracy diff, flip_rate) and further
      inflated by a normal-approximation term for the chosen alpha/power so
      claims cannot ride inside measurement noise.
    - This is a planning threshold, not a proof of equivalence.
    """
    z_alpha = 1.96 if abs(alpha - 0.05) < 1e-9 else abs(
        # crude fallback for other alphas via approx
        1.96
    )
    # z_power ≈ 0.84 for 80%
    z_power = 0.8416 if abs(power - 0.8) < 1e-9 else 0.8416
    n = max(int(sample_size), 1)
    se_term = (z_alpha + z_power) * math.sqrt(max(flip_rate * (1.0 - flip_rate), 1e-6) / n)
    measured = max(float(noise_abs_accuracy_diff), float(flip_rate), 0.0)
    mdi = measured + se_term
    return {
        "minimumDetectableImprovement": mdi,
        "components": {
            "measuredAbsAccuracyDifference": float(noise_abs_accuracy_diff),
            "gradedOutcomeFlipRate": float(flip_rate),
            "normalApproxTerm": se_term,
        },
        "assumptions": {
            "alpha": alpha,
            "power": power,
            "zAlpha": z_alpha,
            "zPower": z_power,
            "sampleSize": n,
            "method": (
                "MDI = max(|acc_A-acc_B|, flip_rate) + (z_alpha+z_power)*sqrt(p(1-p)/n) "
                "with p=flip_rate; paired McNemar + Wilson CIs required for claims."
            ),
            "nonClaim": (
                "Equal aggregate accuracies across two runs do not imply zero noise."
            ),
        },
        "methodsVersion": STAT_METHODS_VERSION,
    }


def adapter_improvement_decision(
    *,
    base_correct: Sequence[bool],
    adapter_correct: Sequence[bool],
    mdi: float,
    minimum_samples: int = 3,
    alpha: float = DEFAULT_ALPHA,
) -> dict[str, Any]:
    paired = paired_counts(base_correct, adapter_correct)
    n = paired["sampleSize"]
    diff = paired["difference"]
    p_value = paired["mcnemarPValue"]
    # Wilson on candidate-only among discordant is already in paired; also CI on overall rates
    base_acc = paired["baselineAccuracy"]
    adap_acc = paired["candidateAccuracy"]
    base_w = wilson_interval(int(round(base_acc * n)), n)
    adap_w = wilson_interval(int(round(adap_acc * n)), n)
    exceeds_mdi = diff > float(mdi)
    significant = n >= minimum_samples and p_value < alpha and exceeds_mdi
    inconclusive = not significant
    return {
        "methodsVersion": STAT_METHODS_VERSION,
        "paired": paired,
        "baseAccuracyWilson": base_w,
        "adapterAccuracyWilson": adap_w,
        "mdi": float(mdi),
        "observedImprovement": diff,
        "exceedsMdi": exceeds_mdi,
        "alpha": alpha,
        "minimumSamples": minimum_samples,
        "promoteEligible": bool(significant),
        "decision": "improve" if significant else "inconclusive",
        "note": (
            "Do not promote when inconclusive. Nonsignificant difference is not "
            "demonstrated equivalence."
        ),
        "inconclusive": inconclusive,
    }


def cross_backend_agreement(
    *,
    vllm_correct: Sequence[bool],
    hf_correct: Sequence[bool],
    noise_floor_abs_diff: float,
    equivalence_tolerance: float | None = None,
) -> dict[str, Any]:
    """Compare backends; nonsignificant ≠ demonstrated equivalence."""
    paired = paired_counts(hf_correct, vllm_correct)  # baseline=HF, candidate=vLLM
    flips = graded_outcome_flip_rate(
        ["correct" if c else "wrong" for c in hf_correct],
        ["correct" if c else "wrong" for c in vllm_correct],
    )
    tol = float(equivalence_tolerance) if equivalence_tolerance is not None else float(noise_floor_abs_diff)
    abs_diff = abs(paired["difference"])
    within_tol = abs_diff <= tol
    return {
        "methodsVersion": STAT_METHODS_VERSION,
        "paired": paired,
        "gradedOutcomeDisagreement": flips,
        "absoluteAccuracyDifference": abs_diff,
        "noiseFloorAbsDiff": float(noise_floor_abs_diff),
        "equivalenceTolerance": tol,
        "withinTolerance": within_tol,
        "pass": within_tol,
        "note": (
            "Pass means |vLLM-HF| accuracy difference ≤ tolerance informed by the "
            "measured noise floor. A nonsignificant McNemar p-value alone is not "
            "demonstrated equivalence."
        ),
        "mcnemarPValue": paired["mcnemarPValue"],
    }
