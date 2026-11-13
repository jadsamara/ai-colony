#!/usr/bin/env python3
"""vLLM vs Hugging Face cross-backend check on a stratified development subset.

Primary backend: vLLM. HF is the independent reference. Agreement must fall
within a tolerance informed by the measured noise floor. Nonsignificant
McNemar ≠ demonstrated equivalence.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from answer_parser import GRADER_VERSION
from decoding import CONDITIONS, matched_job_fields
from generation_utils import PRIMARY_EVAL_BACKEND, REFERENCE_BACKEND, STATISTICAL_GATE_VERSION
from paired_stats import cross_backend_agreement, per_family_accuracy
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned
from statistical_gate import GATE_VERSION, gate_pass_statistical_v1
from subprocess_visibility import run_visible_subprocess
from vllm_eval import _load_jsonl, _write_json, evaluate_condition_on_engine
from vllm_backend import load_vllm_engine
from dev_provenance import DevelopmentProvenanceError, assert_authorized_development_dataset
from stratified_selection import dataset_content_hash

ROOT = Path(__file__).resolve().parent


def _align_flags(
    vllm_rows: list[dict[str, Any]],
    hf_rows: list[dict[str, Any]],
) -> tuple[list[bool], list[bool], list[dict[str, Any]]]:
    def key(r: dict[str, Any]) -> tuple[str, int]:
        return (str(r["itemId"]), int(r.get("sampleIndex") or 0))

    iv = {key(r): r for r in vllm_rows}
    ih = {key(r): r for r in hf_rows}
    keys = sorted(set(iv) & set(ih))
    meta = []
    for k in keys:
        meta.append(
            {
                "itemId": k[0],
                "sampleIndex": k[1],
                "family": iv[k].get("family"),
                "vllmCorrect": bool(iv[k].get("correct")),
                "hfCorrect": bool(ih[k].get("correct")),
                "vllmOutcome": iv[k].get("outcome"),
                "hfOutcome": ih[k].get("outcome"),
            },
        )
    return [bool(iv[k].get("correct")) for k in keys], [bool(ih[k].get("correct")) for k in keys], meta


def run_cross_backend(job: dict[str, Any]) -> dict[str, Any]:
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
    condition_id = job.get("conditionId") or "thinking_disabled_zero_shot"
    fields = matched_job_fields(CONDITIONS[condition_id])
    if job.get("samplesPerProblem") is not None:
        fields = {**fields, "samplesPerProblem": int(job["samplesPerProblem"])}
    # Cross-check default: 1 sample for speed unless thinking requires 3
    if fields.get("enableThinking") and int(fields["samplesPerProblem"]) < 3:
        fields = {**fields, "samplesPerProblem": 3}

    noise_floor_abs = float(job.get("noiseFloorAbsDiff") or 0.0)
    if job.get("noiseFloorReportPath"):
        nf = json.loads(Path(job["noiseFloorReportPath"]).read_text(encoding="utf-8"))
        # Prefer matching condition; else overall MDI component abs diff max
        cond = (nf.get("conditions") or {}).get(condition_id) or {}
        cmp = cond.get("comparison") or {}
        if cmp.get("absoluteAccuracyDifference") is not None:
            noise_floor_abs = float(cmp["absoluteAccuracyDifference"])
        elif nf.get("overallMinimumDetectableImprovement") is not None:
            # Fall back: use MDI as conservative tolerance only if abs diff missing
            noise_floor_abs = float(nf["overallMinimumDetectableImprovement"])
        job_tol = nf.get("conditions", {}).get(condition_id, {}).get("comparison", {}).get("gradedOutcomeFlips", {})
        # Prefer max(abs_diff, flip_rate) as tolerance informed by noise floor
        flip = float((cmp.get("gradedOutcomeFlips") or {}).get("flipRate") or 0.0)
        noise_floor_abs = max(noise_floor_abs, flip)

    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"], revision=pin["tokenizerRevision"], trust_remote_code=True,
    )
    tmpl_fp = template_fingerprint(tokenizer)

    # --- vLLM primary ---
    try:
        llm, engine_meta = load_vllm_engine(
            pin,
            max_model_len=int(fields["maxNewTokens"]) + 4096,
            enable_lora=False,
        )
        vllm_cond = evaluate_condition_on_engine(
            llm=llm,
            items=items,
            tokenizer=tokenizer,
            condition_id=condition_id,
            fields=fields,
            base_seed=seed,
            build_chat_texts=build_chat_texts,
        )
    except Exception as exc:  # noqa: BLE001
        report = {
            "ok": False,
            "gateVersion": GATE_VERSION,
            "error": f"vllm_failed: {type(exc).__name__}: {exc}",
        }
        _write_json(out / "cross-backend-report.json", report)
        return report

    _write_json(out / "vllm-item-results.json", {"access": "evaluation_only", "results": vllm_cond["results"]})

    # --- HF reference via separate interpreter when configured ---
    hf_python = job.get("hfPython") or sys.executable
    hf_job = {
        **{k: job[k] for k in ("modelId", "tokenizerId", "modelRevision", "tokenizerRevision") if k in job},
        "conditionId": condition_id,
        "datasetPath": str(dataset_path),
        "selectionManifestPath": str(manifest_path) if manifest_path else None,
        "outputDir": str(out / "hf-ref"),
        "device": job.get("device") or "cuda",
        "batchSize": int(job.get("batchSize") or 4),
        "seed": seed,
        "samplesPerProblem": fields["samplesPerProblem"],
        "maxNewTokens": fields["maxNewTokens"],
        "accessRole": "evaluation",
        "departmentId": "00000000-0000-4000-8000-000000000017",
    }
    hf_job_path = out / "hf-ref-job.json"
    _write_json(hf_job_path, hf_job)
    (out / "hf-ref").mkdir(parents=True, exist_ok=True)

    # Prefer in-process HF if same interpreter has transformers; else subprocess
    hf_rows: list[dict[str, Any]] = []
    hf_meta: dict[str, Any]
    try:
        from backend_benchmark import run_hf_benchmark

        hf_run = run_hf_benchmark(
            items=items,
            fields=fields,
            pin=pin,
            batch_size=int(job.get("batchSize") or 4),
            seed=seed,
            device=job.get("device") or "cuda",
        )
        hf_rows = hf_run["results"]
        hf_meta = {k: v for k, v in hf_run.items() if k != "results"}
        hf_meta["ok"] = True
    except Exception:
        vis = run_visible_subprocess(
            [
                str(hf_python),
                str(ROOT / "batched_eval.py"),
                "--job",
                str(hf_job_path),
            ],
            output_dir=out / "hf-ref",
            log_stem="hf-batched-eval",
        )
        if not vis.get("ok"):
            report = {
                "ok": False,
                "gateVersion": GATE_VERSION,
                "error": vis.get("error") or "hf_subprocess_failed",
                "stderrLast40Lines": vis.get("stderrLast40Lines"),
                "stdoutLast40Lines": vis.get("stdoutLast40Lines"),
                "subprocess": vis,
            }
            _write_json(out / "cross-backend-report.json", report)
            return report
        item_path = out / "hf-ref" / "item-results.json"
        if not item_path.exists():
            report = {
                "ok": False,
                "gateVersion": GATE_VERSION,
                "error": "hf_item_results_missing",
                "subprocess": vis,
            }
            _write_json(out / "cross-backend-report.json", report)
            return report
        hf_rows = json.loads(item_path.read_text(encoding="utf-8")).get("results") or []
        hf_meta = {"ok": True, "subprocess": vis}

    _write_json(out / "hf-item-results.json", {"access": "evaluation_only", "results": hf_rows})

    vllm_flags, hf_flags, paired_meta = _align_flags(vllm_cond["results"], hf_rows)
    if not paired_meta:
        report = {
            "ok": False,
            "gateVersion": GATE_VERSION,
            "error": "no_overlapping_item_sample_keys",
        }
        _write_json(out / "cross-backend-report.json", report)
        return report

    agreement = cross_backend_agreement(
        vllm_correct=vllm_flags,
        hf_correct=hf_flags,
        noise_floor_abs_diff=noise_floor_abs,
        equivalence_tolerance=job.get("equivalenceTolerance"),
    )
    fam_v = per_family_accuracy([{"family": m["family"], "correct": m["vllmCorrect"]} for m in paired_meta])
    fam_h = per_family_accuracy([{"family": m["family"], "correct": m["hfCorrect"]} for m in paired_meta])

    artifacts_clear = int(vllm_cond.get("prefixArtifactItemSamples") or 0) == 0
    noise_floor_recorded = bool(job.get("noiseFloorReportPath")) or noise_floor_abs >= 0
    gate = gate_pass_statistical_v1(
        artifacts_clear=artifacts_clear,
        noise_floor_recorded=True,
        flip_rates_reported=True,
        cross_backend_pass=bool(agreement.get("pass")),
        unresolved_alignment_artifacts=not artifacts_clear,
    )

    report = {
        "ok": True,
        "gateVersion": GATE_VERSION,
        "statisticalGateVersion": STATISTICAL_GATE_VERSION,
        "primaryEvalBackend": PRIMARY_EVAL_BACKEND,
        "referenceBackend": REFERENCE_BACKEND,
        "graderVersion": GRADER_VERSION,
        "conditionId": condition_id,
        "decoding": fields,
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "datasetPath": str(dataset_path),
        "datasetContentHash": dataset_content_hash(items),
        "developmentProvenance": provenance,
        "itemCount": len(items),
        "seed": seed,
        "samplerImplementation": engine_meta.get("samplerImplementation"),
        "noiseFloorAbsDiffUsed": noise_floor_abs,
        "noiseFloorReportPath": job.get("noiseFloorReportPath"),
        "vllm": {
            "passAt1": vllm_cond["accounting"]["passAt1"],
            "timing": vllm_cond["timing"],
            "engineStartupMs": engine_meta.get("engineStartupMs"),
            "truncationByFamily": vllm_cond.get("truncationByFamily"),
        },
        "huggingface": hf_meta,
        "agreement": agreement,
        "perFamilyAccuracy": {"vllm": fam_v, "huggingface": fam_h},
        "statisticalGate": gate,
        "note": (
            "HF is the independent cross-check. Pass requires |Δacc| within "
            "tolerance informed by the measured noise floor."
        ),
    }
    _write_json(out / "cross-backend-report.json", report)
    if not gate.get("passed"):
        # Retain failure evidence; nonzero exit
        return report
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])
    report = run_cross_backend(job)
    if not report.get("ok"):
        print(json.dumps({"ok": False, "error": report.get("error"), "stderrLast40Lines": report.get("stderrLast40Lines")}, indent=2))
        raise SystemExit(2)
    gate_passed = (report.get("statisticalGate") or {}).get("passed")
    print(json.dumps({"ok": True, "gatePassed": gate_passed, "outputDir": job["outputDir"]}, indent=2))
    if not gate_passed:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
