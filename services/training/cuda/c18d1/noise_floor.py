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
from decoding import CONDITIONS, matched_job_fields
from generation_utils import (
    PRIMARY_EVAL_BACKEND,
    REFERENCE_BACKEND,
    STATISTICAL_GATE_VERSION,
)
from paired_stats import STAT_METHODS_VERSION, STAT_METHODS_VERSION_V1, compare_identical_runs
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

    by_condition: dict[str, Any] = {}
    wall_t0 = time.time()
    for cid in condition_ids:
        fields = matched_job_fields(CONDITIONS[cid])
        if fields.get("enableThinking") and int(fields["samplesPerProblem"]) < 3:
            fields = {**fields, "samplesPerProblem": 3}
        runs = []
        for run_idx in (1, 2):
            cond = evaluate_condition_on_engine(
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
                out / f"item-results-{cid}-run{run_idx}.json",
                {"access": "evaluation_only", "run": run_idx, "results": cond["results"]},
            )
            runs.append(cond)

        cmp = compare_identical_runs(
            runs[0]["results"],
            runs[1]["results"],
            bootstrap_seed=seed,
        )
        item_level = cmp["itemLevel"]
        by_condition[cid] = {
            "decoding": fields,
            "samplesPerProblem": int(fields["samplesPerProblem"]),
            "run1": {
                "passAt1": runs[0]["accounting"]["passAt1"],
                "timing": runs[0]["timing"],
                "truncationByFamily": runs[0]["truncationByFamily"],
                "prefixArtifactItemSamples": runs[0]["prefixArtifactItemSamples"],
            },
            "run2": {
                "passAt1": runs[1]["accounting"]["passAt1"],
                "timing": runs[1]["timing"],
                "truncationByFamily": runs[1]["truncationByFamily"],
                "prefixArtifactItemSamples": runs[1]["prefixArtifactItemSamples"],
            },
            "comparison": cmp,
            "observedNoiseFloor": item_level["observedNoiseFloor"],
            "variabilityConfidenceInterval": item_level["variabilityConfidenceInterval"],
            "minimumDetectableImprovement": item_level["minimumDetectableImprovement"],
            "modelPromotionThreshold": item_level["modelPromotionThreshold"],
            "requestManifestSample": (runs[0].get("requestManifests") or [None])[0],
        }

    # Overall: conservative max across conditions (item-level)
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
        "methodsVersion": STAT_METHODS_VERSION,
        "methodsVersionSupersedes": STAT_METHODS_VERSION_V1,
        "preservePriorReports": (
            "Do not overwrite noise-floor reports written under c18d1-paired-stats-v1; "
            "use a fresh C18D1_OUT directory for this rerun."
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
        "noiseFloorRecorded": True,
        "flipRatesReported": True,
        "artifactsClear": artifacts_clear,
        "layerDefinitions": {
            "observedNoiseFloor": "Measured identical-run item-level |Δacc| and flip rates",
            "variabilityConfidenceInterval": "Item-clustered paired bootstrap CI on signed Δacc",
            "minimumDetectableImprovement": "Planning MDI under alpha/power (not promotion alone)",
            "modelPromotionThreshold": "max(MDI, policy floor, CI half-width) for adapter claims",
        },
        "note": (
            "Replaces exact repeatability for vLLM primary acceptance. "
            "Equal aggregate accuracies / zero flips are not evidence of zero noise. "
            "Thinking-mode samples are clustered by item (not 72 independent problems)."
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
