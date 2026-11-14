#!/usr/bin/env python3
"""Identical-run noise-floor measurement for C1.8D statistical gate.

Runs the base model twice on the same development set with identical settings
for both thinking and non-thinking modes. Does not treat equal aggregate
accuracies as zero noise.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from answer_parser import GRADER_VERSION
from decoding import (
    CONDITIONS,
    DECODING_CONFIG_VERSION,
    alternate_sampling_base_seed,
    matched_job_fields,
)
from generation_utils import (
    EVAL_IMPLEMENTATION_VERSION,
    PRIMARY_EVAL_BACKEND,
    REFERENCE_BACKEND,
    STATISTICAL_GATE_VERSION,
)
from paired_stats import (
    DEFAULT_PRACTICAL_MEANINGFUL_IMPROVEMENT,
    STAT_METHODS_VERSION,
    STAT_METHODS_VERSION_V1,
    compare_identical_runs,
    model_promotion_threshold,
)
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned
from statistical_gate import GATE_ADOPTED_REASON, GATE_VERSION
from vllm_eval import evaluate_condition_on_engine, _load_jsonl, _write_json
from vllm_backend import load_vllm_engine
from dev_provenance import DevelopmentProvenanceError, assert_authorized_development_dataset
from stratified_selection import dataset_content_hash

ROOT = Path(__file__).resolve().parent


def run_noise_floor(job: dict[str, Any]) -> dict[str, Any]:
    import sys

    from transformers import AutoTokenizer

    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts, template_fingerprint

    require_for_baseline(job)
    pin = verify_pinned()
    dataset_path = Path(job["datasetPath"])
    manifest_path = Path(job["selectionManifestPath"]) if job.get("selectionManifestPath") else None
    try:
        provenance = assert_authorized_development_dataset(
            dataset_path,
            manifest_path=manifest_path,
        )
    except DevelopmentProvenanceError as exc:
        raise SystemExit(f"DEVELOPMENT_PROVENANCE_DENIED: {exc}") from exc
    dataset_path = Path(provenance["datasetPath"])
    items = _load_jsonl(dataset_path)
    if job.get("limit"):
        items = items[: int(job["limit"])]

    out = Path(job["outputDir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    seed = int(job.get("seed") or 18)
    condition_ids = job.get("conditionIds") or [
        "thinking_disabled_zero_shot",
        "thinking_enabled_zero_shot",
    ]

    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"], revision=pin["tokenizerRevision"], trust_remote_code=True,
    )
    tmpl_fp = template_fingerprint(tokenizer)
    max_new = 8192
    try:
        llm, engine_meta = load_vllm_engine(pin, max_model_len=max_new + 4096, enable_lora=False)
    except Exception as exc:  # noqa: BLE001
        report = {
            "ok": False,
            "gateVersion": GATE_VERSION,
            "error": f"vllm_engine_load_failed: {type(exc).__name__}: {exc}",
        }
        _write_json(out / "noise-floor-report.json", report)
        return report

    def _run_summary(cond: dict[str, Any]) -> dict[str, Any]:
        return {
            "passAt1": cond["accounting"]["passAt1"],
            "timing": cond["timing"],
            "truncationByFamily": cond["truncationByFamily"],
            "prefixArtifactItemSamples": cond["prefixArtifactItemSamples"],
            "totalGeneratedTokens": cond.get("totalGeneratedTokens"),
            "tokensPerSecond": cond.get("tokensPerSecond"),
        }

    def _pair_block(
        results_a: list[dict[str, Any]],
        results_b: list[dict[str, Any]],
        *,
        kind: str,
        seed_a: int,
        seed_b: int,
    ) -> dict[str, Any]:
        cmp = compare_identical_runs(results_a, results_b, bootstrap_seed=seed_a)
        item_level = cmp["itemLevel"]
        ci = item_level["variabilityConfidenceInterval"]["signedDifferenceCI"]
        half = 0.5 * abs(float(ci["high"]) - float(ci["low"]))
        promo = model_promotion_threshold(
            mdi=item_level["minimumDetectableImprovement"]["minimumDetectableImprovement"],
            variability_ci_halfwidth=half,
            noise_floor_kind=kind,
        )
        return {
            "noiseFloorKind": kind,
            "baseSeedA": seed_a,
            "baseSeedB": seed_b,
            "comparison": cmp,
            "observedNoiseFloor": item_level["observedNoiseFloor"],
            "variabilityConfidenceInterval": item_level["variabilityConfidenceInterval"],
            "minimumDetectableImprovement": item_level["minimumDetectableImprovement"],
            "modelPromotionThreshold": promo,
            "perFamily": cmp.get("perFamily"),
        }

    by_condition: dict[str, Any] = {}
    wall_t0 = time.time()
    for cid in condition_ids:
        fields = matched_job_fields(CONDITIONS[cid])
        if fields.get("enableThinking") and int(fields["samplesPerProblem"]) < 3:
            fields = {**fields, "samplesPerProblem": 3}
        # Same-seed pair (backend nondeterminism)
        run1 = evaluate_condition_on_engine(
            llm=llm,
            items=items,
            tokenizer=tokenizer,
            condition_id=cid,
            fields=fields,
            base_seed=seed,
            build_chat_texts=build_chat_texts,
            adapter_path=None,
        )
        _write_json(
            out / f"item-results-{cid}-same-seed-run1.json",
            {"access": "evaluation_only", "noiseFloorKind": "same_seed_backend_nondeterminism", "run": 1, "results": run1["results"]},
        )
        run2 = evaluate_condition_on_engine(
            llm=llm,
            items=items,
            tokenizer=tokenizer,
            condition_id=cid,
            fields=fields,
            base_seed=seed,
            build_chat_texts=build_chat_texts,
            adapter_path=None,
        )
        _write_json(
            out / f"item-results-{cid}-same-seed-run2.json",
            {"access": "evaluation_only", "noiseFloorKind": "same_seed_backend_nondeterminism", "run": 2, "results": run2["results"]},
        )
        same_seed = _pair_block(
            run1["results"],
            run2["results"],
            kind="same_seed_backend_nondeterminism",
            seed_a=seed,
            seed_b=seed,
        )
        entry: dict[str, Any] = {
            "decoding": fields,
            "decodingConfigVersion": fields.get("decodingConfigVersion", DECODING_CONFIG_VERSION),
            "samplesPerProblem": int(fields["samplesPerProblem"]),
            "run1": _run_summary(run1),
            "run2": _run_summary(run2),
            "sameSeedNoiseFloor": same_seed,
            # Default promotion fields: same-seed (thinking-disabled / greedy pairing).
            # Thinking-enabled overrides below to alternate-seed sampling variance.
            "comparison": same_seed["comparison"],
            "observedNoiseFloor": same_seed["observedNoiseFloor"],
            "variabilityConfidenceInterval": same_seed["variabilityConfidenceInterval"],
            "minimumDetectableImprovement": same_seed["minimumDetectableImprovement"],
            "modelPromotionThreshold": same_seed["modelPromotionThreshold"],
            "promotionNoiseFloorKind": "same_seed_backend_nondeterminism",
            "requestManifestSample": (run1.get("requestManifests") or [None])[0],
        }

        if fields.get("enableThinking"):
            alt_seed = alternate_sampling_base_seed(seed)
            run_alt = evaluate_condition_on_engine(
                llm=llm,
                items=items,
                tokenizer=tokenizer,
                condition_id=cid,
                fields=fields,
                base_seed=alt_seed,
                build_chat_texts=build_chat_texts,
                adapter_path=None,
            )
            _write_json(
                out / f"item-results-{cid}-alt-seed-run.json",
                {
                    "access": "evaluation_only",
                    "noiseFloorKind": "alternate_seed_sampling_variance",
                    "baseSeed": alt_seed,
                    "results": run_alt["results"],
                },
            )
            alt = _pair_block(
                run1["results"],
                run_alt["results"],
                kind="alternate_seed_sampling_variance",
                seed_a=seed,
                seed_b=alt_seed,
            )
            entry["alternateSeedNoiseFloor"] = alt
            entry["alternateSeedRun"] = _run_summary(run_alt)
            # Thinking stochastic policy: alternate-seed floor is the promotion reference;
            # same-seed remains a backend-nondeterminism diagnostic only.
            entry["comparison"] = alt["comparison"]
            entry["observedNoiseFloor"] = alt["observedNoiseFloor"]
            entry["variabilityConfidenceInterval"] = alt["variabilityConfidenceInterval"]
            entry["minimumDetectableImprovement"] = alt["minimumDetectableImprovement"]
            entry["modelPromotionThreshold"] = alt["modelPromotionThreshold"]
            entry["promotionNoiseFloorKind"] = "alternate_seed_sampling_variance"
            entry["thinkingNoiseFloorNote"] = (
                "alternateSeedNoiseFloor = sampling variance under the intended stochastic "
                "decoding policy (promotion reference for thinking-enabled base-vs-adapter). "
                "sameSeedNoiseFloor = backend nondeterminism diagnostic only. "
                "vLLM does not guarantee per-request seed pairing under continuous batching; "
                "SamplingParams(seed=…) is recorded but not treated as exact reproducibility."
            )

        by_condition[cid] = entry

    # Overall: conservative max of same-seed MDIs / promotion thresholds across conditions
    mdis = [
        by_condition[c]["minimumDetectableImprovement"]["minimumDetectableImprovement"]
        for c in condition_ids
    ]
    promos = [
        by_condition[c]["modelPromotionThreshold"]["modelPromotionThreshold"]
        for c in condition_ids
    ]
    overall_mdi = max(mdis) if mdis else 0.0
    overall_promo = max(promos) if promos else 0.0
    artifacts_clear = all(
        by_condition[c]["run1"]["prefixArtifactItemSamples"] == 0
        and by_condition[c]["run2"]["prefixArtifactItemSamples"] == 0
        for c in condition_ids
    )

    report = {
        "ok": True,
        "gateVersion": GATE_VERSION,
        "adoptedReason": GATE_ADOPTED_REASON,
        "statisticalGateVersion": STATISTICAL_GATE_VERSION,
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "decodingConfigVersion": DECODING_CONFIG_VERSION,
        "methodsVersion": STAT_METHODS_VERSION,
        "methodsVersionSupersedes": STAT_METHODS_VERSION_V1,
        "preservePriorReports": (
            "Do not overwrite prior noise-floor reports; use a fresh C18D1_OUT. "
            "Do not treat the stratified 24-item 21.24% MDI as an automatic full-dev "
            "promotion threshold."
        ),
        "primaryEvalBackend": PRIMARY_EVAL_BACKEND,
        "referenceBackend": REFERENCE_BACKEND,
        "graderVersion": GRADER_VERSION,
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "datasetPath": str(dataset_path),
        "datasetContentHash": dataset_content_hash(items),
        "developmentProvenance": provenance,
        "itemCount": len(items),
        "fullDevelopment": bool(job.get("fullDevelopment")) or (
            manifest_path is None and "id_dev.jsonl" in str(dataset_path)
        ),
        "seed": seed,
        "samplerImplementation": engine_meta.get("samplerImplementation"),
        "timing": {
            "engineStartupMs": engine_meta.get("engineStartupMs"),
            "warmupMs": engine_meta.get("warmupMs"),
            "wallClockMs": int((time.time() - wall_t0) * 1000),
        },
        "conditions": by_condition,
        "overallMinimumDetectableImprovement": overall_mdi,
        "overallModelPromotionThreshold": overall_promo,
        "minimumPracticallyMeaningfulImprovement": DEFAULT_PRACTICAL_MEANINGFUL_IMPROVEMENT,
        "promotionComparator": {
            "thinking_disabled_zero_shot": "same_seed_backend_nondeterminism",
            "thinking_enabled_zero_shot": "alternate_seed_sampling_variance",
            "note": (
                "Thinking-enabled base-vs-adapter comparisons use the alternate-seed "
                "sampling floor as the variability reference under stochastic decoding. "
                "Same-seed remains a diagnostic. Thinking-disabled (greedy) still uses "
                "same-seed. Do not change decoding config or rerun GPU without approval. "
                "Proposed future thinking samplesPerProblem≥4 is documentation-only until approved."
            ),
        },
        "noiseFloorRecorded": True,
        "flipRatesReported": True,
        "artifactsClear": artifacts_clear,
        "lockedDataAccessed": False,
        "layerDefinitions": {
            "observedNoiseFloor": "Measured identical-run item-level |Δacc| and flip rates",
            "variabilityConfidenceInterval": "Item-clustered paired bootstrap CI on signed Δacc",
            "minimumDetectableImprovement": "Statistical detectability under alpha/power (planning)",
            "minimumPracticallyMeaningfulImprovement": (
                "Separate practical floor; not implied by 24-item MDI alone"
            ),
            "modelPromotionThreshold": (
                "max(MDI, practical_meaningful, policy_floor, CI half-width); "
                "state noiseFloorKindComparedAgainst"
            ),
        },
        "note": (
            "Replaces exact repeatability for vLLM primary acceptance. "
            "Equal aggregate accuracies / zero flips are not evidence of zero noise. "
            "Thinking-mode samples are clustered by item. "
            f"Grader {GRADER_VERSION}; decoding {DECODING_CONFIG_VERSION}."
        ),
    }
    _write_json(out / "noise-floor-report.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])
    report = run_noise_floor(job)
    if not report.get("ok"):
        raise SystemExit(2)
    print(
        json.dumps(
            {
                "ok": True,
                "outputDir": job["outputDir"],
                "methodsVersion": report.get("methodsVersion"),
                "mdi": report.get("overallMinimumDetectableImprovement"),
                "promotionThreshold": report.get("overallModelPromotionThreshold"),
            },
            indent=2,
        ),
    )


if __name__ == "__main__":
    main()
