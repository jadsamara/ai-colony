#!/usr/bin/env python3
"""Primary vLLM batched evaluation for C1.8D.1 (statistical gate era).

- One engine per run, reused across conditions
- All requests for a condition/sample-index in one generate() call
- Per-request SamplingParams(seed=...) from sampling_seed_schedule
- Records engine startup vs eval time and sampler implementation
- HF remains reference cross-check only (see cross_backend_check.py)
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from accounting import build_accounting
from answer_parser import GRADER_VERSION
from batch_invariance_metrics import detect_prefix_artifacts
from decoding import CONDITIONS, matched_job_fields
from dev_provenance import DevelopmentProvenanceError, assert_authorized_development_dataset
from generation_utils import (
    BATCHING_POLICY,
    EVAL_IMPLEMENTATION_VERSION,
    PRIMARY_EVAL_BACKEND,
    PROMPT_INSTRUCTION_VERSION,
    REFERENCE_BACKEND,
    STATISTICAL_GATE_VERSION,
)
from peft_eval_common_bridge import conservative_from_outcomes
from reproducibility import build_reproducibility_manifest
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned
from stratified_selection import dataset_content_hash
from sympy_grader import grade_model_output
from vllm_backend import (
    BACKEND_ID,
    BACKEND_STATUS,
    build_prompts,
    build_request_manifest,
    generate_texts_vllm,
    load_vllm_engine,
)

ROOT = Path(__file__).resolve().parent


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _truncation_by_family(results: list[dict[str, Any]]) -> dict[str, Any]:
    by_fam: dict[str, list[bool]] = {}
    missing_final: dict[str, list[bool]] = {}
    for row in results:
        fam = str(row.get("family") or "unknown")
        by_fam.setdefault(fam, []).append(bool(row.get("truncated")))
        missing = row.get("outcome") in {"invalid", "truncated"} and row.get("invalidReason") in {
            "no_answer_line",
            "missing",
            "empty",
            None,
        }
        # Prefer explicit missing final from invalidReason when present
        inv = str(row.get("invalidReason") or "")
        miss = bool(row.get("truncated")) or inv in {"no_answer_line", "missing", "empty", "malformed"}
        missing_final.setdefault(fam, []).append(miss)
    out = {}
    for fam, flags in sorted(by_fam.items()):
        trunc_n = sum(1 for f in flags if f)
        miss_flags = missing_final.get(fam, [])
        miss_n = sum(1 for f in miss_flags if f)
        out[fam] = {
            "sampleSize": len(flags),
            "truncationCount": trunc_n,
            "truncationRate": trunc_n / len(flags) if flags else 0.0,
            "missingFinalAnswerCount": miss_n,
            "missingFinalAnswerRate": miss_n / len(miss_flags) if miss_flags else 0.0,
        }
    return out


def evaluate_condition_on_engine(
    *,
    llm: Any,
    items: list[dict[str, Any]],
    tokenizer: Any,
    condition_id: str,
    fields: dict[str, Any],
    base_seed: int,
    build_chat_texts: Any,
    adapter_path: str | None = None,
    few_shot: str | None = None,
) -> dict[str, Any]:
    """Run one condition: for each sample_index, one batched generate for all items."""
    prompts = build_prompts(
        items,
        tokenizer,
        enable_thinking=bool(fields["enableThinking"]),
        build_chat_texts=build_chat_texts,
        few_shot=few_shot,
    )
    samples_per = int(fields.get("samplesPerProblem") or 1)
    item_indices = list(range(len(items)))
    results: list[dict[str, Any]] = []
    manifests: list[dict[str, Any]] = []
    prefix_hits = 0
    eval_t0 = time.time()
    total_tokens = 0

    for sample_index in range(samples_per):
        manifest = build_request_manifest(
            items=items,
            prompts=prompts,
            fields=fields,
            base_seed=base_seed,
            sample_index=sample_index,
            item_indices=item_indices,
        )
        manifests.append(manifest)
        gens = generate_texts_vllm(
            llm=llm,
            prompts=prompts,
            fields=fields,
            base_seed=base_seed,
            item_indices=item_indices,
            sample_index=sample_index,
            adapter_path=adapter_path,
        )
        for item, gen in zip(items, gens):
            truncated = bool(gen.get("truncated"))
            graded = grade_model_output(
                gen["text"],
                item["expected"],
                enable_thinking=bool(fields["enableThinking"]),
                truncated=truncated,
            )
            arts = detect_prefix_artifacts(gen["text"], enable_thinking=bool(fields["enableThinking"]))
            if arts:
                prefix_hits += 1
            total_tokens += int(gen.get("generatedTokens") or 0)
            results.append(
                {
                    "itemId": item["id"],
                    "family": item["family"],
                    "difficulty": item["difficulty"],
                    "sampleIndex": sample_index,
                    "samplingSeed": gen["samplingSeed"],
                    "rawPrediction": gen["text"],
                    "truncated": truncated,
                    "outcome": graded["outcome"],
                    "correct": graded["correct"],
                    "mathematicalCorrect": graded.get("mathematicalCorrect", graded["correct"]),
                    "formatCompliant": graded.get("formatCompliant", False),
                    "thinkingProtocolViolation": graded.get("thinkingProtocolViolation", False),
                    "invalidReason": graded.get("invalidReason"),
                    "parsed": graded["parsed"],
                    "grade": graded["grade"],
                    "graderVersion": graded.get("graderVersion", GRADER_VERSION),
                    "generatedTokens": gen.get("generatedTokens"),
                    "runtimeMs": gen.get("runtimeMs"),
                    "finishReason": gen.get("finishReason"),
                    "prefixArtifacts": arts,
                    "adapterPath": adapter_path,
                    "backend": BACKEND_ID,
                },
            )

    eval_ms = int((time.time() - eval_t0) * 1000)
    accounting = build_accounting(results, samples_per_problem=samples_per)
    conservative = conservative_from_outcomes([r["outcome"] for r in results])
    return {
        "conditionId": condition_id,
        "decoding": fields,
        "results": results,
        "requestManifests": manifests,
        "accounting": accounting,
        "conservative": conservative,
        "truncationByFamily": _truncation_by_family(results),
        "prefixArtifactItemSamples": prefix_hits,
        "timing": {"evalMs": eval_ms},
        "totalGeneratedTokens": total_tokens,
        "tokensPerSecond": (total_tokens / (eval_ms / 1000.0)) if eval_ms else None,
        "adapterPath": adapter_path,
    }


def run_vllm_eval(job: dict[str, Any]) -> dict[str, Any]:
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
    adapter_path = job.get("adapterPath")
    condition_ids = job.get("conditionIds") or [job.get("conditionId") or "thinking_disabled_zero_shot"]

    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"], revision=pin["tokenizerRevision"], trust_remote_code=True,
    )
    tmpl_fp = template_fingerprint(tokenizer)

    max_new = max(
        int(matched_job_fields(CONDITIONS[cid]).get("maxNewTokens") or 512)
        for cid in condition_ids
    )
    if job.get("maxNewTokens"):
        max_new = max(max_new, int(job["maxNewTokens"]))

    try:
        llm, engine_meta = load_vllm_engine(
            pin,
            max_model_len=max(max_new + 4096, 16384),
            enable_lora=bool(adapter_path),
        )
    except Exception as exc:  # noqa: BLE001
        report = {
            "ok": False,
            "backend": BACKEND_ID,
            "backendStatus": BACKEND_STATUS,
            "primaryEvalBackend": PRIMARY_EVAL_BACKEND,
            "referenceBackend": REFERENCE_BACKEND,
            "error": f"vllm_engine_load_failed: {type(exc).__name__}: {exc}",
            "gateReference": STATISTICAL_GATE_VERSION,
        }
        _write_json(out / "eval-report.json", report)
        return report

    conditions_out: dict[str, Any] = {}
    all_results: list[dict[str, Any]] = []
    for cid in condition_ids:
        condition = CONDITIONS[cid]
        fields = matched_job_fields(condition)
        if job.get("maxNewTokens") and not fields.get("enableThinking"):
            # Allow override for non-thinking; thinking stays at condition cap unless forced
            pass
        if job.get("maxNewTokens") and fields.get("enableThinking"):
            # Thinking mode must remain 8192 unless job explicitly forces (record)
            if int(job["maxNewTokens"]) != int(fields["maxNewTokens"]):
                fields = {**fields, "maxNewTokens": int(fields["maxNewTokens"])}
                fields["maxNewTokensPinnedThinking"] = 8192
        if job.get("samplesPerProblem") is not None:
            fields = {**fields, "samplesPerProblem": int(job["samplesPerProblem"])}
        # Enforce thinking samples >= 3 when thinking enabled unless explicitly overridden lower (record)
        if fields.get("enableThinking") and int(fields["samplesPerProblem"]) < 3:
            if not job.get("allowFewerThinkingSamples"):
                fields = {**fields, "samplesPerProblem": 3}

        cond_report = evaluate_condition_on_engine(
            llm=llm,
            items=items,
            tokenizer=tokenizer,
            condition_id=cid,
            fields=fields,
            base_seed=seed,
            build_chat_texts=build_chat_texts,
            adapter_path=adapter_path,
            few_shot=job.get("fewShotText"),
        )
        public = {k: v for k, v in cond_report.items() if k != "results"}
        conditions_out[cid] = public
        _write_json(out / f"item-results-{cid}.json", {"access": "evaluation_only", "results": cond_report["results"]})
        all_results.extend(cond_report["results"])

    # Primary condition metrics for top-level convenience
    primary_cid = condition_ids[0]
    primary = conditions_out[primary_cid]
    report = {
        "ok": True,
        "specVersion": EVAL_IMPLEMENTATION_VERSION,
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "graderVersion": GRADER_VERSION,
        "promptInstructionVersion": PROMPT_INSTRUCTION_VERSION,
        "backend": BACKEND_ID,
        "backendStatus": BACKEND_STATUS,
        "primaryEvalBackend": PRIMARY_EVAL_BACKEND,
        "referenceBackend": REFERENCE_BACKEND,
        "vllmUsed": True,
        "statisticalGateVersion": STATISTICAL_GATE_VERSION,
        "samplerImplementation": engine_meta.get("samplerImplementation"),
        "samplerDetail": engine_meta.get("detail"),
        "model": require_for_baseline({**job, **pin}),
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "conditionIds": condition_ids,
        "conditions": conditions_out,
        "passAt1": primary["accounting"]["passAt1"],
        "passAt1Definition": primary["accounting"]["passAt1Definition"],
        "mathematicalAccuracy": primary["accounting"]["perSample"]["mathematicalAccuracy"],
        "formatComplianceRate": primary["accounting"]["perSample"]["formatComplianceRate"],
        "truncationRate": primary["accounting"]["perSample"]["truncationRate"],
        "truncationByFamily": primary.get("truncationByFamily"),
        "accounting": primary.get("conservative"),
        "detailedAccounting": primary.get("accounting"),
        "batchingPolicy": {
            **BATCHING_POLICY,
            "vllmSingleGeneratePerSampleIndex": True,
            "perRequestSamplingParamsSeed": True,
        },
        "samplingSeedPolicy": {
            "baseSeed": seed,
            "schedule": "sampling_seed_schedule(base, itemIndex, sampleIndex)",
            "batchSubmit": True,
        },
        "datasetPath": str(dataset_path),
        "datasetContentHash": dataset_content_hash(items),
        "developmentProvenance": provenance,
        "adapterPath": adapter_path,
        "itemCount": len(items),
        "timing": {
            "engineStartupMs": engine_meta.get("engineStartupMs"),
            "warmupMs": engine_meta.get("warmupMs"),
            "conditions": {cid: conditions_out[cid]["timing"] for cid in condition_ids},
        },
        "libraries": {
            "torch": getattr(__import__("torch"), "__version__", None),
            "vllm": getattr(__import__("vllm"), "__version__", None),
        },
        "reproducibility": build_reproducibility_manifest(
            pinned=pin,
            decoding=primary.get("decoding") or {},
            batch_size=len(items),
            dataset_path=dataset_path,
            dataset_content_hash=dataset_content_hash(items),
            backend=BACKEND_ID,
            template_fingerprint=tmpl_fp,
            condition_id=primary_cid,
            seed=seed,
            extra={
                "graderVersion": GRADER_VERSION,
                "statisticalGateVersion": STATISTICAL_GATE_VERSION,
                "samplerImplementation": engine_meta.get("samplerImplementation"),
            },
        ),
        "ollamaTouched": False,
    }
    _write_json(out / "eval-report.json", report)
    _write_json(out / "reproducibility-manifest.json", report["reproducibility"])
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])
    report = run_vllm_eval(job)
    if not report.get("ok"):
        raise SystemExit(2)
    print(json.dumps({"ok": True, "outputDir": job["outputDir"], "backend": BACKEND_ID}, indent=2))


if __name__ == "__main__":
    main()
