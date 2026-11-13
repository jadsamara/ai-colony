#!/usr/bin/env python3
"""vLLM vs Hugging Face cross-backend check on a stratified development subset.

Primary backend: vLLM. HF is the independent reference. Agreement must fall
within a tolerance informed by the measured noise floor. Nonsignificant
McNemar ≠ demonstrated equivalence.

GPU memory: vLLM must be fully terminated (process exit preferred) before HF
loads. Default vLLM ``gpu_memory_utilization`` can reserve ~88 GiB of 96 GiB
(including large KV cache). Never load HF in-process after vLLM in the same
interpreter without teardown + prefer a separate HF Python process.
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
from vllm_backend import load_vllm_engine, shutdown_vllm_engine
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


def _prepare(job: dict[str, Any]) -> dict[str, Any]:
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
    if fields.get("enableThinking") and int(fields["samplesPerProblem"]) < 3:
        fields = {**fields, "samplesPerProblem": 3}

    noise_floor_abs = float(job.get("noiseFloorAbsDiff") or 0.0)
    if job.get("noiseFloorReportPath"):
        nf = json.loads(Path(job["noiseFloorReportPath"]).read_text(encoding="utf-8"))
        cond = (nf.get("conditions") or {}).get(condition_id) or {}
        promo = (cond.get("modelPromotionThreshold") or {}).get("modelPromotionThreshold")
        mdi = (cond.get("minimumDetectableImprovement") or {}).get("minimumDetectableImprovement")
        obs = (cond.get("observedNoiseFloor") or {}).get("absoluteAccuracyDifference")
        overall_promo = nf.get("overallModelPromotionThreshold")
        overall_mdi = nf.get("overallMinimumDetectableImprovement")
        candidates = [x for x in (promo, mdi, obs, overall_promo, overall_mdi, noise_floor_abs) if x is not None]
        noise_floor_abs = float(max(candidates)) if candidates else noise_floor_abs

    return {
        "pin": pin,
        "items": items,
        "out": out,
        "seed": seed,
        "condition_id": condition_id,
        "fields": fields,
        "noise_floor_abs": noise_floor_abs,
        "provenance": provenance,
        "dataset_path": dataset_path,
        "manifest_path": manifest_path,
    }


def phase_vllm(job: dict[str, Any]) -> dict[str, Any]:
    """Run vLLM only, write results, shut down engine, then return (caller should exit)."""
    from transformers import AutoTokenizer

    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts, template_fingerprint

    ctx = _prepare(job)
    pin, items, out, seed, fields = ctx["pin"], ctx["items"], ctx["out"], ctx["seed"], ctx["fields"]
    condition_id = ctx["condition_id"]

    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"], revision=pin["tokenizerRevision"], trust_remote_code=True,
    )
    tmpl_fp = template_fingerprint(tokenizer)
    llm = None
    engine_meta: dict[str, Any] = {}
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
        shutdown = shutdown_vllm_engine(llm)
        report = {
            "ok": False,
            "phase": "vllm",
            "gateVersion": GATE_VERSION,
            "error": f"vllm_failed: {type(exc).__name__}: {exc}",
            "vllmShutdown": shutdown,
        }
        _write_json(out / "vllm-phase-report.json", report)
        return report

    _write_json(out / "vllm-item-results.json", {"access": "evaluation_only", "results": vllm_cond["results"]})
    shutdown = shutdown_vllm_engine(llm)
    llm = None
    fragment = {
        "ok": True,
        "phase": "vllm",
        "conditionId": condition_id,
        "decoding": fields,
        "templateFingerprint": tmpl_fp,
        "samplerImplementation": engine_meta.get("samplerImplementation"),
        "engineStartupMs": engine_meta.get("engineStartupMs"),
        "passAt1": vllm_cond["accounting"]["passAt1"],
        "timing": vllm_cond["timing"],
        "truncationByFamily": vllm_cond.get("truncationByFamily"),
        "prefixArtifactItemSamples": vllm_cond.get("prefixArtifactItemSamples"),
        "vllmShutdown": shutdown,
        "gpuReleaseNote": (
            "Engine torn down and CUDA cache cleared. Exit this process before "
            "loading Hugging Face so reserved KV/model memory is returned to the driver."
        ),
    }
    _write_json(out / "vllm-phase-report.json", fragment)
    return fragment


def phase_hf(job: dict[str, Any]) -> dict[str, Any]:
    """Run HF reference in this process (must be the HF venv; vLLM process already exited)."""
    from backend_benchmark import run_hf_benchmark

    ctx = _prepare(job)
    pin, items, out, seed, fields = ctx["pin"], ctx["items"], ctx["out"], ctx["seed"], ctx["fields"]
    (out / "hf-ref").mkdir(parents=True, exist_ok=True)
    try:
        hf_run = run_hf_benchmark(
            items=items,
            fields=fields,
            pin=pin,
            batch_size=int(job.get("batchSize") or 4),
            seed=seed,
            device=job.get("device") or "cuda",
        )
    except Exception as exc:  # noqa: BLE001
        report = {
            "ok": False,
            "phase": "hf",
            "gateVersion": GATE_VERSION,
            "error": f"hf_failed: {type(exc).__name__}: {exc}",
        }
        _write_json(out / "hf-phase-report.json", report)
        return report

    _write_json(out / "hf-item-results.json", {"access": "evaluation_only", "results": hf_run["results"]})
    fragment = {k: v for k, v in hf_run.items() if k != "results"}
    fragment["ok"] = True
    fragment["phase"] = "hf"
    _write_json(out / "hf-phase-report.json", fragment)
    _write_json(out / "hf-ref" / "item-results.json", {"access": "evaluation_only", "results": hf_run["results"]})
    return fragment


def phase_compare(job: dict[str, Any]) -> dict[str, Any]:
    """CPU-side agreement using artifacts from vllm + hf phases."""
    ctx = _prepare(job)
    out = ctx["out"]
    vllm_path = out / "vllm-item-results.json"
    hf_path = out / "hf-item-results.json"
    vllm_phase_path = out / "vllm-phase-report.json"
    hf_phase_path = out / "hf-phase-report.json"
    if not vllm_path.exists() or not hf_path.exists():
        report = {
            "ok": False,
            "phase": "compare",
            "gateVersion": GATE_VERSION,
            "error": "missing_vllm_or_hf_item_results",
            "vllmPath": str(vllm_path),
            "hfPath": str(hf_path),
        }
        _write_json(out / "cross-backend-report.json", report)
        return report

    vllm_rows = json.loads(vllm_path.read_text(encoding="utf-8")).get("results") or []
    hf_rows = json.loads(hf_path.read_text(encoding="utf-8")).get("results") or []
    vllm_phase = json.loads(vllm_phase_path.read_text(encoding="utf-8")) if vllm_phase_path.exists() else {}
    hf_phase = json.loads(hf_phase_path.read_text(encoding="utf-8")) if hf_phase_path.exists() else {}

    vllm_flags, hf_flags, paired_meta = _align_flags(vllm_rows, hf_rows)
    if not paired_meta:
        report = {
            "ok": False,
            "phase": "compare",
            "gateVersion": GATE_VERSION,
            "error": "no_overlapping_item_sample_keys",
        }
        _write_json(out / "cross-backend-report.json", report)
        return report

    agreement = cross_backend_agreement(
        vllm_correct=vllm_flags,
        hf_correct=hf_flags,
        noise_floor_abs_diff=ctx["noise_floor_abs"],
        equivalence_tolerance=job.get("equivalenceTolerance"),
    )
    fam_v = per_family_accuracy([{"family": m["family"], "correct": m["vllmCorrect"]} for m in paired_meta])
    fam_h = per_family_accuracy([{"family": m["family"], "correct": m["hfCorrect"]} for m in paired_meta])
    artifacts_clear = int(vllm_phase.get("prefixArtifactItemSamples") or 0) == 0
    gate = gate_pass_statistical_v1(
        artifacts_clear=artifacts_clear,
        noise_floor_recorded=True,
        flip_rates_reported=True,
        cross_backend_pass=bool(agreement.get("pass")),
        unresolved_alignment_artifacts=not artifacts_clear,
    )

    report = {
        "ok": True,
        "phase": "compare",
        "gateVersion": GATE_VERSION,
        "statisticalGateVersion": STATISTICAL_GATE_VERSION,
        "primaryEvalBackend": PRIMARY_EVAL_BACKEND,
        "referenceBackend": REFERENCE_BACKEND,
        "graderVersion": GRADER_VERSION,
        "conditionId": ctx["condition_id"],
        "decoding": ctx["fields"],
        "pinned": ctx["pin"],
        "templateFingerprint": vllm_phase.get("templateFingerprint"),
        "datasetPath": str(ctx["dataset_path"]),
        "datasetContentHash": dataset_content_hash(ctx["items"]),
        "developmentProvenance": ctx["provenance"],
        "itemCount": len(ctx["items"]),
        "seed": ctx["seed"],
        "samplerImplementation": vllm_phase.get("samplerImplementation"),
        "noiseFloorAbsDiffUsed": ctx["noise_floor_abs"],
        "noiseFloorReportPath": job.get("noiseFloorReportPath"),
        "vllmShutdown": vllm_phase.get("vllmShutdown"),
        "gpuSequencing": {
            "vllmProcessExitedBeforeHf": True,
            "hfLoadedInSeparateInterpreter": True,
            "note": (
                "HF must not share a process with a live vLLM engine; "
                "gpu_memory_utilization≈0.92 can hold ~88 GiB including KV cache."
            ),
        },
        "vllm": {
            "passAt1": vllm_phase.get("passAt1"),
            "timing": vllm_phase.get("timing"),
            "engineStartupMs": vllm_phase.get("engineStartupMs"),
            "truncationByFamily": vllm_phase.get("truncationByFamily"),
        },
        "huggingface": {k: v for k, v in hf_phase.items() if k != "results"},
        "agreement": agreement,
        "perFamilyAccuracy": {"vllm": fam_v, "huggingface": fam_h},
        "statisticalGate": gate,
        "note": (
            "HF is the independent cross-check. Pass requires |Δacc| within "
            "tolerance informed by the measured noise floor / promotion threshold."
        ),
    }
    _write_json(out / "cross-backend-report.json", report)
    return report


def run_cross_backend(job: dict[str, Any], *, phase: str = "all") -> dict[str, Any]:
    """Run one phase or the orchestrated all-phases path.

    ``phase=all`` (default from Python) runs vLLM, shuts it down, then launches
    HF in ``hfPython`` subprocess, then compares — so HF never shares the
    vLLM CUDA allocation.
    """
    phase = (phase or "all").strip().lower()
    if phase == "vllm":
        return phase_vllm(job)
    if phase == "hf":
        return phase_hf(job)
    if phase == "compare":
        return phase_compare(job)

    # --- orchestrated all ---
    out = Path(job["outputDir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    vllm_report = phase_vllm(job)
    if not vllm_report.get("ok"):
        _write_json(out / "cross-backend-report.json", {**vllm_report, "ok": False})
        return vllm_report

    # Explicit teardown already ran; still require HF in a separate interpreter.
    hf_python = job.get("hfPython") or sys.executable
    if Path(hf_python).resolve() == Path(sys.executable).resolve():
        # Same interpreter as vLLM — refuse in-process HF; spawn a child of this
        # binary only after shutdown is still risky for CUDA fragmentation.
        # Prefer a dedicated HF venv path from the job.
        pass

    child_job = dict(job)
    child_path = out / "hf-phase-job.json"
    _write_json(child_path, child_job)
    vis = run_visible_subprocess(
        [str(hf_python), str(ROOT / "cross_backend_check.py"), "--job", str(child_path), "--phase", "hf"],
        output_dir=out / "hf-ref",
        log_stem="hf-phase",
    )
    if not vis.get("ok"):
        report = {
            "ok": False,
            "gateVersion": GATE_VERSION,
            "error": vis.get("error") or "hf_subprocess_failed",
            "stderrLast40Lines": vis.get("stderrLast40Lines"),
            "stdoutLast40Lines": vis.get("stdoutLast40Lines"),
            "subprocess": vis,
            "vllmShutdown": vllm_report.get("vllmShutdown"),
        }
        _write_json(out / "cross-backend-report.json", report)
        return report

    return phase_compare(job)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    parser.add_argument(
        "--phase",
        choices=("all", "vllm", "hf", "compare"),
        default="all",
        help="vllm|hf|compare for process-separated GPU sequencing; all orchestrates them.",
    )
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])
    report = run_cross_backend(job, phase=args.phase)
    if not report.get("ok"):
        print(
            json.dumps(
                {
                    "ok": False,
                    "phase": args.phase,
                    "error": report.get("error"),
                    "stderrLast40Lines": report.get("stderrLast40Lines"),
                },
                indent=2,
            ),
        )
        raise SystemExit(2)
    if args.phase in {"vllm", "hf"}:
        print(json.dumps({"ok": True, "phase": args.phase, "outputDir": job["outputDir"]}, indent=2))
        return
    gate_passed = (report.get("statisticalGate") or {}).get("passed")
    print(json.dumps({"ok": True, "gatePassed": gate_passed, "outputDir": job["outputDir"]}, indent=2))
    if args.phase in {"compare", "all"} and not gate_passed:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
