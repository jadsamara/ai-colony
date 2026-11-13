#!/usr/bin/env python3
"""Paired statistics for C1.8D statistical evaluation gate (CPU-testable).

v2 (current): item-clustered analysis, bootstrap CI on signed paired accuracy
difference, and MDI that does not collapse when zero flips are observed.

v1 reports remain valid under ``methodsVersion=c18d1-paired-stats-v1`` and must
not be silently rewritten.
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from typing import Any, Sequence


STAT_METHODS_VERSION = "c18d1-paired-stats-v2"
STAT_METHODS_VERSION_V1 = "c18d1-paired-stats-v1"  # preserved historical
DEFAULT_Z = 1.96
DEFAULT_ALPHA = 0.05
DEFAULT_BOOTSTRAP_REPS = 5000
# Policy floor for promotion (absolute accuracy points); recorded separately from MDI.
DEFAULT_PROMOTION_POLICY_FLOOR = 0.02


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


def rule_of_three_upper95(events: int, n: int) -> float | None:
    """Classic ~95% upper bound on a rate when events==0: 3/n. None if events>0."""
    if int(events) != 0 or int(n) <= 0:
        return None
    return 3.0 / float(n)


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
    discordant = base_only + cand_only
    # Wilson on P(candidate|discordant) is NOT a CI for the signed accuracy difference.
    # Keep it labeled as discordant-composition only; signed CI comes from bootstrap.
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
        "discordantCompositionWilson": (
            wilson_interval(cand_only, discordant)
            if discordant > 0
            else {"low": 0.0, "high": 0.0, "z": DEFAULT_Z, "note": "no_discordant_pairs"}
        ),
        # Deprecated alias kept for v1 readers; do not treat as signed-diff CI.
        "differenceWilson": {
            "deprecated": True,
            "note": (
                "Not a CI for signed paired accuracy difference. "
                "Use signedDifferenceBootstrapCI (item-clustered)."
            ),
            "discordantCompositionWilson": (
                wilson_interval(cand_only, discordant)
                if discordant > 0
                else {"low": 0.0, "high": 0.0, "z": DEFAULT_Z}
            ),
        },
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
        "ruleOfThreeUpper95": rule_of_three_upper95(flips, n),
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


def _index_rows(
    rows: Sequence[dict[str, Any]],
    *,
    id_key: str,
    sample_key: str,
) -> dict[tuple[str, int], dict[str, Any]]:
    return {(str(r[id_key]), int(r.get(sample_key) or 0)): r for r in rows}


def cluster_paired_items(
    rows_a: Sequence[dict[str, Any]],
    rows_b: Sequence[dict[str, Any]],
    *,
    id_key: str = "itemId",
    sample_key: str = "sampleIndex",
) -> list[dict[str, Any]]:
    """Group overlapping response pairs by item (independent unit for inference)."""
    ia, ib = _index_rows(rows_a, id_key=id_key, sample_key=sample_key), _index_rows(
        rows_b, id_key=id_key, sample_key=sample_key,
    )
    keys = sorted(set(ia) & set(ib))
    by_item: dict[str, dict[str, Any]] = {}
    for item_id, sample_index in keys:
        row_a = ia[(item_id, sample_index)]
        row_b = ib[(item_id, sample_index)]
        bucket = by_item.setdefault(
            item_id,
            {
                "itemId": item_id,
                "family": row_a.get("family") or row_b.get("family"),
                "sampleIndices": [],
                "correctA": [],
                "correctB": [],
                "outcomesA": [],
                "outcomesB": [],
            },
        )
        bucket["sampleIndices"].append(sample_index)
        bucket["correctA"].append(bool(row_a.get("correct")))
        bucket["correctB"].append(bool(row_b.get("correct")))
        bucket["outcomesA"].append(str(row_a.get("outcome") or ""))
        bucket["outcomesB"].append(str(row_b.get("outcome") or ""))

    items: list[dict[str, Any]] = []
    for item_id in sorted(by_item):
        b = by_item[item_id]
        mean_a = accuracy_rate(b["correctA"])
        mean_b = accuracy_rate(b["correctB"])
        any_outcome_flip = any(x != y for x, y in zip(b["outcomesA"], b["outcomesB"]))
        items.append(
            {
                **b,
                "samplesPerItem": len(b["sampleIndices"]),
                "meanAccuracyA": mean_a,
                "meanAccuracyB": mean_b,
                "signedMeanAccuracyDifference": mean_b - mean_a,
                "anyOutcomeFlip": any_outcome_flip,
                "meanAccuracyChanged": mean_a != mean_b,
            },
        )
    return items


def item_clustered_bootstrap_ci(
    item_signed_diffs: Sequence[float],
    *,
    n_bootstrap: int = DEFAULT_BOOTSTRAP_REPS,
    seed: int = 18,
    alpha: float = DEFAULT_ALPHA,
) -> dict[str, Any]:
    """Percentile CI for the mean signed paired accuracy difference; resample items."""
    diffs = [float(x) for x in item_signed_diffs]
    n = len(diffs)
    if n == 0:
        raise ValueError("bootstrap requires at least one item")
    observed = sum(diffs) / n
    rng = random.Random(int(seed))
    means: list[float] = []
    for _ in range(int(n_bootstrap)):
        sample = [diffs[rng.randrange(n)] for _ in range(n)]
        means.append(sum(sample) / n)
    means.sort()
    lo_idx = int(math.floor((alpha / 2.0) * n_bootstrap))
    hi_idx = int(math.ceil((1.0 - alpha / 2.0) * n_bootstrap)) - 1
    lo_idx = max(0, min(lo_idx, n_bootstrap - 1))
    hi_idx = max(0, min(hi_idx, n_bootstrap - 1))
    abs_means = sorted(abs(m) for m in means)
    return {
        "method": "item_clustered_paired_bootstrap_percentile",
        "nItems": n,
        "nBootstrap": int(n_bootstrap),
        "seed": int(seed),
        "alpha": float(alpha),
        "observedMeanSignedDifference": observed,
        "signedDifferenceCI": {
            "low": means[lo_idx],
            "high": means[hi_idx],
        },
        "absoluteMeanDifferenceCI": {
            "low": abs_means[lo_idx],
            "high": abs_means[hi_idx],
            "note": (
                "Percentile CI of |bootstrap mean signed diff|; not a CI for a "
                "one-sided absolute estimand with optimal coverage."
            ),
        },
    }


def discordant_rate_for_mdi(
    *,
    item_flip_count: int,
    n_items: int,
) -> dict[str, Any]:
    """Rate used inside MDI SE; never collapses to ~0 solely because flips==0."""
    n = max(int(n_items), 1)
    flips = int(item_flip_count)
    observed = flips / n
    wilson = wilson_interval(flips, n)
    rule3 = rule_of_three_upper95(flips, n)
    # Conservative planning rate: max(observed, Wilson upper, rule-of-3 when 0).
    candidates = [observed, float(wilson["high"])]
    if rule3 is not None:
        candidates.append(rule3)
    used = max(candidates)
    return {
        "observedItemFlipRate": observed,
        "wilson": wilson,
        "ruleOfThreeUpper95": rule3,
        "rateUsedForMdi": used,
        "rationale": (
            "Use max(observed, Wilson upper95[, rule-of-three 3/n when flips=0]) "
            "so zero observed flips do not imply near-zero detectable improvement."
        ),
    }


def minimum_detectable_improvement(
    *,
    n_items: int,
    item_flip_count: int,
    observed_abs_item_accuracy_diff: float = 0.0,
    power: float = 0.8,
    alpha: float = DEFAULT_ALPHA,
) -> dict[str, Any]:
    """MDI on the item-mean accuracy scale (independent units = items).

    For paired binary/mean outcomes, SE of the mean signed difference is
    approximately ``sqrt(π_d / n)`` when π_d is the discordant/flip rate across
    ``n`` independent items. MDI = (z_{α/2} + z_{power}) * SE with π_d taken from
    ``discordant_rate_for_mdi`` (never artificially near-zero at 0 flips).

    This is a **planning** quantity under explicit power assumptions — not the
    observed noise floor and not automatically the promotion threshold.
    """
    z_alpha = 1.96 if abs(alpha - 0.05) < 1e-9 else 1.96
    z_power = 0.8416 if abs(power - 0.8) < 1e-9 else 0.8416
    n = max(int(n_items), 1)
    disc = discordant_rate_for_mdi(item_flip_count=item_flip_count, n_items=n)
    pi = max(float(disc["rateUsedForMdi"]), 1.0 / (n + 3.0))  # soft floor
    se = math.sqrt(pi / n)
    mdi = (z_alpha + z_power) * se
    # Also ensure MDI is at least the observed absolute item-level shift.
    mdi = max(mdi, float(observed_abs_item_accuracy_diff))
    return {
        "minimumDetectableImprovement": mdi,
        "effectiveIndependentItems": n,
        "discordantRate": disc,
        "standardError": se,
        "components": {
            "zAlpha": z_alpha,
            "zPower": z_power,
            "observedAbsItemAccuracyDifference": float(observed_abs_item_accuracy_diff),
        },
        "assumptions": {
            "alpha": alpha,
            "power": power,
            "estimand": "mean item-level accuracy difference (samples within item averaged)",
            "seModel": "sqrt(pi_d / n_items) with pi_d from discordant_rate_for_mdi",
            "clustering": (
                "Repeated samples within an item are correlated; n is the item count, "
                "not response count."
            ),
            "nonClaim": (
                "Equal aggregate accuracies or zero observed flips do not imply zero noise."
            ),
        },
        "methodsVersion": STAT_METHODS_VERSION,
        "layer": "minimum_detectable_improvement",
    }


def model_promotion_threshold(
    *,
    mdi: float,
    policy_floor: float = DEFAULT_PROMOTION_POLICY_FLOOR,
    variability_ci_halfwidth: float | None = None,
) -> dict[str, Any]:
    """Actual threshold adapters must beat — distinct from planning MDI.

    promotion_threshold = max(MDI, policy_floor, optional CI half-width).
    """
    parts = [float(mdi), float(policy_floor)]
    if variability_ci_halfwidth is not None:
        parts.append(float(variability_ci_halfwidth))
    value = max(parts)
    return {
        "modelPromotionThreshold": value,
        "inputs": {
            "mdi": float(mdi),
            "policyFloor": float(policy_floor),
            "variabilityCiHalfwidth": variability_ci_halfwidth,
        },
        "rule": "max(MDI, policy_floor[, bootstrap_|CI|_halfwidth])",
        "layer": "model_promotion_threshold",
        "note": (
            "Promotion requires observed paired improvement > this threshold with "
            "McNemar (or item-clustered paired test) significant at alpha; "
            "inconclusive → do not promote."
        ),
        "methodsVersion": STAT_METHODS_VERSION,
    }


def compare_identical_runs(
    rows_a: Sequence[dict[str, Any]],
    rows_b: Sequence[dict[str, Any]],
    *,
    id_key: str = "itemId",
    sample_key: str = "sampleIndex",
    bootstrap_reps: int = DEFAULT_BOOTSTRAP_REPS,
    bootstrap_seed: int = 18,
) -> dict[str, Any]:
    """Noise-floor comparison with response-level diagnostics + item-level inference."""
    ia = _index_rows(rows_a, id_key=id_key, sample_key=sample_key)
    ib = _index_rows(rows_b, id_key=id_key, sample_key=sample_key)
    keys = sorted(set(ia) & set(ib))
    if not keys:
        raise ValueError("no overlapping item/sample keys between identical runs")

    correct_a = [bool(ia[k].get("correct")) for k in keys]
    correct_b = [bool(ib[k].get("correct")) for k in keys]
    outcomes_a = [str(ia[k].get("outcome") or "") for k in keys]
    outcomes_b = [str(ib[k].get("outcome") or "") for k in keys]
    paired_resp = paired_counts(correct_a, correct_b)
    flips_resp = graded_outcome_flip_rate(outcomes_a, outcomes_b)
    acc_a = accuracy_rate(correct_a)
    acc_b = accuracy_rate(correct_b)

    items = cluster_paired_items(rows_a, rows_b, id_key=id_key, sample_key=sample_key)
    n_items = len(items)
    samples_per = sorted({it["samplesPerItem"] for it in items})
    mean_a = sum(it["meanAccuracyA"] for it in items) / n_items
    mean_b = sum(it["meanAccuracyB"] for it in items) / n_items
    signed = mean_b - mean_a
    abs_diff = abs(signed)
    item_flips = sum(1 for it in items if it["anyOutcomeFlip"])
    item_mean_flips = sum(1 for it in items if it["meanAccuracyChanged"])
    item_flip_rate = item_flips / n_items
    signed_diffs = [it["signedMeanAccuracyDifference"] for it in items]
    boot = item_clustered_bootstrap_ci(
        signed_diffs, n_bootstrap=bootstrap_reps, seed=bootstrap_seed,
    )
    # Binary item-level "first or any" for McNemar diagnostic: use mean>0.5 as correct
    item_correct_a = [it["meanAccuracyA"] >= 0.5 for it in items]
    item_correct_b = [it["meanAccuracyB"] >= 0.5 for it in items]
    paired_item = paired_counts(item_correct_a, item_correct_b)

    mdi = minimum_detectable_improvement(
        n_items=n_items,
        item_flip_count=item_flips,
        observed_abs_item_accuracy_diff=abs_diff,
    )
    ci = boot["signedDifferenceCI"]
    half = 0.5 * abs(float(ci["high"]) - float(ci["low"]))
    promo = model_promotion_threshold(
        mdi=mdi["minimumDetectableImprovement"],
        variability_ci_halfwidth=half,
    )

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
        "layers": {
            "observedNoiseFloor": (
                "Item-level absolute/signed mean-accuracy difference and item flip rates "
                "from the identical-run pair."
            ),
            "variabilityConfidenceInterval": (
                "Item-clustered paired bootstrap percentile CI for the signed mean "
                "accuracy difference."
            ),
            "minimumDetectableImprovement": (
                "Planning MDI under alpha/power with discordant-rate floor so zero "
                "flips are not treated as zero noise."
            ),
            "modelPromotionThreshold": (
                "max(MDI, policy floor, bootstrap CI half-width); adapters must beat this."
            ),
        },
        # --- Response level (diagnostic; correlated when samplesPerItem>1) ---
        "responseLevel": {
            "diagnosticOnly": True,
            "pairedSampleSize": len(keys),
            "accuracyA": acc_a,
            "accuracyB": acc_b,
            "absoluteAccuracyDifference": abs(acc_a - acc_b),
            "paired": paired_resp,
            "gradedOutcomeFlips": flips_resp,
            "note": (
                "Do not treat response count as independent n when multiple samples "
                "share an item (e.g. thinking mode samplesPerProblem=3)."
            ),
        },
        # --- Item level (primary inference) ---
        "itemLevel": {
            "independentItemCount": n_items,
            "samplesPerItemObserved": samples_per,
            "meanAccuracyA": mean_a,
            "meanAccuracyB": mean_b,
            "observedNoiseFloor": {
                "signedAccuracyDifference": signed,
                "absoluteAccuracyDifference": abs_diff,
                "itemOutcomeFlipCount": item_flips,
                "itemOutcomeFlipRate": item_flip_rate,
                "itemMeanAccuracyChangeCount": item_mean_flips,
                "itemMeanAccuracyChangeRate": item_mean_flips / n_items,
                "flipRateWilson": wilson_interval(item_flips, n_items),
                "ruleOfThreeUpper95": rule_of_three_upper95(item_flips, n_items),
            },
            "variabilityConfidenceInterval": boot,
            "pairedMeanThresholdMcNemar": paired_item,
            "minimumDetectableImprovement": mdi,
            "modelPromotionThreshold": promo,
        },
        # Back-compat top-level fields (item-level preferred)
        "pairedSampleSize": n_items,
        "accuracyA": mean_a,
        "accuracyB": mean_b,
        "absoluteAccuracyDifference": abs_diff,
        "paired": paired_item,
        "gradedOutcomeFlips": {
            "sampleSize": n_items,
            "flipCount": item_flips,
            "flipRate": item_flip_rate,
            "flipRateWilson": wilson_interval(item_flips, n_items),
            "ruleOfThreeUpper95": rule_of_three_upper95(item_flips, n_items),
            "unit": "items",
        },
        "perFamily": {"runA": fam_a, "runB": fam_b, "differences": fam_diff},
        "note": (
            "Primary units are items. Response-level counts are diagnostic. "
            "Identical aggregate accuracies are not evidence of zero noise."
        ),
    }


def adapter_improvement_decision(
    *,
    base_correct: Sequence[bool],
    adapter_correct: Sequence[bool],
    mdi: float,
    promotion_threshold: float | None = None,
    minimum_samples: int = 3,
    alpha: float = DEFAULT_ALPHA,
) -> dict[str, Any]:
    """Decision helper; ``base_correct``/``adapter_correct`` should be **item-level** flags."""
    paired = paired_counts(base_correct, adapter_correct)
    n = paired["sampleSize"]
    diff = paired["difference"]
    p_value = paired["mcnemarPValue"]
    base_acc = paired["baselineAccuracy"]
    adap_acc = paired["candidateAccuracy"]
    base_w = wilson_interval(int(round(base_acc * n)), n)
    adap_w = wilson_interval(int(round(adap_acc * n)), n)
    threshold = float(promotion_threshold) if promotion_threshold is not None else float(mdi)
    exceeds = diff > threshold
    significant = n >= minimum_samples and p_value < alpha and exceeds
    return {
        "methodsVersion": STAT_METHODS_VERSION,
        "paired": paired,
        "baseAccuracyWilson": base_w,
        "adapterAccuracyWilson": adap_w,
        "mdi": float(mdi),
        "promotionThreshold": threshold,
        "observedImprovement": diff,
        "exceedsPromotionThreshold": exceeds,
        "exceedsMdi": diff > float(mdi),
        "alpha": alpha,
        "minimumSamples": minimum_samples,
        "promoteEligible": bool(significant),
        "decision": "improve" if significant else "inconclusive",
        "note": (
            "Do not promote when inconclusive. Nonsignificant difference is not "
            "demonstrated equivalence. Prefer item-level flags when samples are clustered."
        ),
        "inconclusive": not significant,
    }


def cross_backend_agreement(
    *,
    vllm_correct: Sequence[bool],
    hf_correct: Sequence[bool],
    noise_floor_abs_diff: float,
    equivalence_tolerance: float | None = None,
) -> dict[str, Any]:
    """Compare backends; nonsignificant ≠ demonstrated equivalence.

    Callers should pass **item-level** correctness when samples are clustered.
    """
    paired = paired_counts(hf_correct, vllm_correct)
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
            "measured noise floor / promotion threshold. A nonsignificant McNemar "
            "p-value alone is not demonstrated equivalence. Use item-level units."
        ),
        "mcnemarPValue": paired["mcnemarPValue"],
    }
