#!/usr/bin/env python3
"""Batched Hugging Face evaluation for C1.8D.1 Math baselines (official backend).

Official backend: huggingface-batched. vLLM is experimental (see backend_benchmark /
vllm_repeatability) and must not silently replace this path.

Does not touch production Ollama containers.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from access_control import LockedTestAccessError, assert_can_read_locked_items, redact_item_level
from accounting import build_accounting
from answer_parser import GRADER_VERSION
from decoding import CONDITIONS, matched_job_fields, sampling_seed_schedule
from dev_provenance import DevelopmentProvenanceError, assert_authorized_development_dataset
from generation_utils import (
    BATCHING_POLICY,
    EVAL_IMPLEMENTATION_VERSION,
    FINAL_ANSWER_INSTRUCTION,
    OFFICIAL_BACKEND,
    PROMPT_INSTRUCTION_VERSION,
    apply_sampling_seed,
    assert_left_padding,
    build_generate_kwargs,
    filter_unsupported_generate_kwargs,
    prompt_token_length,
    slice_new_token_ids,
)
from peft_eval_common_bridge import conservative_from_outcomes
from reproducibility import build_reproducibility_manifest
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned
from stratified_selection import dataset_content_hash
from sympy_grader import grade_model_output

ROOT = Path(__file__).resolve().parent


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _load_checkpoint(path: Path) -> dict[str, Any]:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"completedIds": [], "results": []}


def build_user_prompt(item: dict[str, Any], *, few_shot: str | None = None) -> str:
    prefix = ""
    if few_shot:
        prefix = few_shot.strip() + "\n\n"
    # Item prompts already contain the math question; append a consistent contract.
    return f"{prefix}{item['prompt']}\n\n{FINAL_ANSWER_INSTRUCTION}"


def _aggregate_metrics(results: list[dict[str, Any]], *, samples_per_problem: int) -> dict[str, Any]:
    by_item: dict[str, list[dict[str, Any]]] = {}
    for row in results:
        by_item.setdefault(row["itemId"], []).append(row)

    pass3_correct = 0
    outcomes_first: list[str] = []
    think_violations = 0
    for _item_id, rows in by_item.items():
        rows = sorted(rows, key=lambda r: r["sampleIndex"])
        first = rows[0]
        outcomes_first.append(first["outcome"])
        if any(r["correct"] for r in rows[:3]):
            pass3_correct += 1
        if first.get("thinkingProtocolViolation"):
            think_violations += 1

    n = len(by_item)
    detailed = build_accounting(results, samples_per_problem=samples_per_problem)
    conservative = conservative_from_outcomes([r["outcome"] for r in results])
    incomplete_families: list[str] = []
    family_trunc: dict[str, list[bool]] = {}
    for row in results:
        if row["sampleIndex"] == 0:
            family_trunc.setdefault(row["family"], []).append(bool(row["truncated"]))
    for family, flags in family_trunc.items():
        if flags and (sum(flags) / len(flags)) > 0.25:
            incomplete_families.append(family)

    per_sample = detailed["perSample"]
    return {
        "byItem": by_item,
        # pass@1 = mean over all samples (sampleSize = items × samplesPerProblem)
        "passAt1": detailed["passAt1"],
        "passAt1Definition": detailed["passAt1Definition"],
        "passAt3": (pass3_correct / n) if n else 0.0,
        "mathematicalAccuracy": per_sample["mathematicalAccuracy"],
        "formatComplianceRate": per_sample["formatComplianceRate"],
        "invalidMathematicalAnswers": per_sample["invalid"],
        "wrongMathematicalAnswers": per_sample["wrong"],
        "truncationRate": per_sample["truncationRate"],
        "thinkingModeProtocolViolations": think_violations,
        "accounting": conservative,
        "detailedAccounting": detailed,
        "incompleteFamilies": incomplete_families,
        "itemCount": n,
        "sampleSize": detailed["sampleSize"],
    }


def run_batched_hf(job: dict[str, Any]) -> dict[str, Any]:
    """Official baseline path: pinned revisions + batched HF generate."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    import sys

    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts, template_fingerprint

    require_for_baseline(job)
    pin = verify_pinned()
    condition = CONDITIONS[job["conditionId"]]
    fields = matched_job_fields(condition)

    dataset_path = Path(job["datasetPath"])
    development_provenance = None
    if "locked" in {p.lower() for p in dataset_path.parts} or "locked" in {
        p.lower() for p in dataset_path.resolve().parts
    }:
        assert_can_read_locked_items(role=job.get("accessRole"), department_id=job.get("departmentId"))
        dataset_path = dataset_path.resolve()
    else:
        try:
            development_provenance = assert_authorized_development_dataset(
                dataset_path,
                manifest_path=(
                    Path(job["selectionManifestPath"]) if job.get("selectionManifestPath") else None
                ),
            )
        except DevelopmentProvenanceError as exc:
            raise SystemExit(f"DEVELOPMENT_PROVENANCE_DENIED: {exc}") from exc
        dataset_path = Path(development_provenance["datasetPath"])

    items = _load_jsonl(dataset_path)
    if job.get("limit"):
        items = items[: int(job["limit"])]

    out = Path(job["outputDir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    ckpt_path = out / "checkpoint.json"
    ckpt = _load_checkpoint(ckpt_path)
    done = set(ckpt.get("completedIds") or [])
    results: list[dict[str, Any]] = list(ckpt.get("results") or [])

    device = job.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
    batch_size = int(job.get("batchSize") or 4)
    adapter_path = job.get("adapterPath")
    base_seed = int(job.get("seed") or 18)

    load_started = time.time()
    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"],
        revision=pin["tokenizerRevision"],
        trust_remote_code=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    assert_left_padding(tokenizer)
    model = AutoModelForCausalLM.from_pretrained(
        pin["modelId"],
        revision=pin["modelRevision"],
        trust_remote_code=True,
        torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32,
    )
    if adapter_path:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, adapter_path)
    if device != "cpu":
        model.to(device)
    model.eval()
    load_ms = int((time.time() - load_started) * 1000)
    tmpl_fp = template_fingerprint(tokenizer)

    pending = [item for item in items if item["id"] not in done]
    # Preserve original dataset indices for seed schedule even after checkpoint resume.
    id_to_index = {item["id"]: idx for idx, item in enumerate(items)}
    samples_per = int(fields["samplesPerProblem"])
    eval_started = time.time()
    peak_vram = None
    seed_policy_notes: list[dict[str, Any]] = []

    for start in range(0, len(pending), batch_size):
        if job.get("cancelFlagPath") and Path(job["cancelFlagPath"]).exists():
            break
        batch = pending[start : start + batch_size]
        for sample_index in range(samples_per):
            prompts: list[str] = []
            for item in batch:
                user = build_user_prompt(item, few_shot=job.get("fewShotText"))
                prompt, _ = build_chat_texts(
                    tokenizer,
                    user,
                    None,
                    enable_thinking=bool(fields["enableThinking"]),
                )
                prompts.append(prompt)

            gen_base = filter_unsupported_generate_kwargs(
                build_generate_kwargs(
                    fields=fields,
                    pad_token_id=tokenizer.pad_token_id,
                    eos_token_id=tokenizer.eos_token_id,
                ),
            )

            # Greedy: true batch. Sampling: per-item generate for RNG isolation.
            texts: list[str] = []
            truncated_flags: list[bool] = []
            token_counts: list[int] = []
            runtime_ms_list: list[float] = []
            if fields["doSample"]:
                for row_index, item in enumerate(batch):
                    item_index = id_to_index[item["id"]]
                    seed = sampling_seed_schedule(base_seed, item_index, sample_index)
                    seed_meta = apply_sampling_seed(torch, seed, device=device)
                    if len(seed_policy_notes) < 3:
                        seed_policy_notes.append({**seed_meta, "itemId": item["id"], "mode": "per_item"})
                    t0 = time.time()
                    encoded_one = tokenizer([prompts[row_index]], return_tensors="pt", padding=True)
                    encoded_one = {key: value.to(device) for key, value in encoded_one.items()}
                    prompt_len = prompt_token_length(int(encoded_one["input_ids"].shape[1]))
                    with torch.no_grad():
                        generated = model.generate(**encoded_one, **gen_base)
                    new_tokens = slice_new_token_ids(generated[0], prompt_len)
                    truncated = int(new_tokens.shape[0]) >= int(fields["maxNewTokens"])
                    if tokenizer.eos_token_id is not None and tokenizer.eos_token_id in set(new_tokens.tolist()):
                        truncated = False
                    texts.append(tokenizer.decode(new_tokens, skip_special_tokens=True))
                    truncated_flags.append(truncated)
                    token_counts.append(int(new_tokens.shape[0]))
                    runtime_ms_list.append((time.time() - t0) * 1000.0)
            else:
                t0 = time.time()
                encoded = tokenizer(prompts, return_tensors="pt", padding=True)
                encoded = {key: value.to(device) for key, value in encoded.items()}
                prompt_len = prompt_token_length(int(encoded["input_ids"].shape[1]))
                with torch.no_grad():
                    generated = model.generate(**encoded, **gen_base)
                batch_ms = (time.time() - t0) * 1000.0
                for row_index in range(len(batch)):
                    new_tokens = slice_new_token_ids(generated[row_index], prompt_len)
                    truncated = int(new_tokens.shape[0]) >= int(fields["maxNewTokens"])
                    if tokenizer.eos_token_id is not None and tokenizer.eos_token_id in set(new_tokens.tolist()):
                        truncated = False
                    texts.append(tokenizer.decode(new_tokens, skip_special_tokens=True))
                    truncated_flags.append(truncated)
                    token_counts.append(int(new_tokens.shape[0]))
                    runtime_ms_list.append(batch_ms / max(len(batch), 1))

            for row_index, item in enumerate(batch):
                item_index = id_to_index[item["id"]]
                text = texts[row_index]
                truncated = truncated_flags[row_index]
                graded = grade_model_output(
                    text,
                    item["expected"],
                    enable_thinking=bool(fields["enableThinking"]),
                    truncated=truncated,
                )
                result = {
                    "itemId": item["id"],
                    "family": item["family"],
                    "difficulty": item["difficulty"],
                    "sampleIndex": sample_index,
                    "samplingSeed": sampling_seed_schedule(base_seed, item_index, sample_index),
                    "rawPrediction": text,
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
                    "generatedTokens": token_counts[row_index],
                    "runtimeMs": runtime_ms_list[row_index],
                }
                results.append(result)
                if sample_index == samples_per - 1:
                    done.add(item["id"])

            if device == "cuda" and torch.cuda.is_available():
                peak_vram = int(torch.cuda.max_memory_allocated())
            _write_json(
                ckpt_path,
                {
                    "completedIds": sorted(done),
                    "results": results,
                    "batchSize": batch_size,
                    "partial": True,
                },
            )

    eval_ms = int((time.time() - eval_started) * 1000)
    metrics = _aggregate_metrics(results, samples_per_problem=samples_per)

    gpu_info: dict[str, Any] | None = None
    if device == "cuda" and torch.cuda.is_available():
        gpu_info = {
            "name": torch.cuda.get_device_name(0),
            "deviceCount": torch.cuda.device_count(),
            "capability": list(torch.cuda.get_device_capability(0)),
        }

    detailed = metrics["detailedAccounting"]
    report = {
        "ok": True,
        "specVersion": EVAL_IMPLEMENTATION_VERSION,
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "graderVersion": GRADER_VERSION,
        "promptInstructionVersion": PROMPT_INSTRUCTION_VERSION,
        "backend": OFFICIAL_BACKEND,
        "vllmUsed": False,
        "vllmDeferredReason": (
            "Official backend remains huggingface-batched. vLLM is experimental; "
            "see backend_benchmark.py / vllm_repeatability.py. Do not silently replace HF."
        ),
        "model": require_for_baseline({**job, **pin}),
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "conditionId": job["conditionId"],
        "decoding": fields,
        "samplingSeedPolicy": {
            "baseSeed": base_seed,
            "schedule": "sampling_seed_schedule(base, itemIndex, sampleIndex)",
            "generateKwargGenerator": False,
            "perItemGenerateWhenSampling": bool(fields["doSample"]),
            "notes": seed_policy_notes
            or [
                {
                    "method": "torch.manual_seed[+cuda.manual_seed_all]",
                    "generatorKwargUsed": False,
                    "note": (
                        "Greedy path has no sampling RNG. "
                        "Sampling uses per-item generate + manual_seed for isolation."
                    ),
                },
            ],
            "remainingLimitations": (
                []
                if fields["doSample"]
                else [
                    "Greedy wording can differ across batch shapes due to bf16 near-ties; "
                    "Gate v3 accepts on canonical/outcome agreement + repeatability, "
                    "not exact text. Batch-shape numerical diffs remain unexplained.",
                ]
            ),
        },
        "batchingPolicy": {
            **BATCHING_POLICY,
            "batchSize": batch_size,
        },
        "datasetPath": str(dataset_path),
        "datasetContentHash": dataset_content_hash(items),
        "developmentProvenance": development_provenance,
        "adapterPath": adapter_path,
        "batchSize": batch_size,
        "itemCount": metrics["itemCount"],
        "sampleSize": metrics["sampleSize"],
        "samplesPerProblem": samples_per,
        "passAt1": metrics["passAt1"],
        "passAt1Definition": metrics["passAt1Definition"],
        "passAt3": metrics["passAt3"],
        "mathematicalAccuracy": metrics["mathematicalAccuracy"],
        "formatComplianceRate": metrics["formatComplianceRate"],
        "invalidMathematicalAnswers": metrics["invalidMathematicalAnswers"],
        "wrongMathematicalAnswers": metrics["wrongMathematicalAnswers"],
        "truncationRate": metrics["truncationRate"],
        "thinkingModeProtocolViolations": metrics["thinkingModeProtocolViolations"],
        "accounting": metrics["accounting"],
        "detailedAccounting": detailed,
        "familyDifficulty": detailed.get("familyDifficulty"),
        "incompleteFamilies": metrics["incompleteFamilies"],
        "timing": {
            "modelLoadMs": load_ms,
            "evalMs": eval_ms,
            "wallClockMs": load_ms + eval_ms,
        },
        "peakVramBytes": peak_vram,
        "gpu": gpu_info,
        "ollamaTouched": False,
        "libraries": {
            "torch": getattr(__import__("torch"), "__version__", None),
            "transformers": getattr(__import__("transformers"), "__version__", None),
        },
        "reproducibility": build_reproducibility_manifest(
            pinned=pin,
            decoding=fields,
            batch_size=batch_size,
            dataset_path=dataset_path,
            dataset_content_hash=dataset_content_hash(items),
            backend=OFFICIAL_BACKEND,
            template_fingerprint=tmpl_fp,
            condition_id=job["conditionId"],
            seed=base_seed,
        ),
        "aggregateForLearningAgents": redact_item_level(
            {
                "conditionId": job["conditionId"],
                "passAt1": metrics["passAt1"],
                "passAt1Definition": metrics["passAt1Definition"],
                "passAt3": metrics["passAt3"],
                "mathematicalAccuracy": metrics["mathematicalAccuracy"],
                "formatComplianceRate": metrics["formatComplianceRate"],
                "sampleSize": metrics["sampleSize"],
                "accounting": metrics["accounting"],
                "incompleteFamilies": metrics["incompleteFamilies"],
                "graderVersion": GRADER_VERSION,
                "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
            },
        ),
    }
    _write_json(out / "eval-report.json", report)
    _write_json(out / "item-results.json", {"access": "evaluation_only", "results": results})
    _write_json(
        out / "invalid-sample-diagnostics.json",
        {
            "access": "evaluation_only",
            "items": detailed.get("invalidSampleDiagnostics") or [],
        },
    )
    _write_json(out / "reproducibility-manifest.json", report["reproducibility"])
    _write_json(ckpt_path, {"completedIds": sorted(done), "results": results, "partial": False})
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key if key != "tokenizerRevision" else "tokenizerRevision"])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])
    try:
        report = run_batched_hf(job)
    except LockedTestAccessError as exc:
        raise SystemExit(f"ACCESS_DENIED: {exc}") from exc
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "passAt1": report["passAt1"],
                "mathematicalAccuracy": report["mathematicalAccuracy"],
                "formatComplianceRate": report["formatComplianceRate"],
                "graderVersion": report["graderVersion"],
                "outputDir": job["outputDir"],
            },
            indent=2,
        ),
    )


if __name__ == "__main__":
    main()
