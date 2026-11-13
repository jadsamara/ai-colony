#!/usr/bin/env python3
"""Batched Hugging Face evaluation for C1.8D.1 Math baselines.

vLLM is deferred unless HF batching proves insufficient on the GPU VM.
Does not touch production Ollama containers.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from access_control import LockedTestAccessError, assert_can_read_locked_items, redact_item_level
from answer_parser import parse_model_output
from decoding import CONDITIONS, matched_job_fields, sampling_seed_schedule
from peft_eval_common_bridge import conservative_from_outcomes
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned
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
    return (
        f"{prefix}{item['prompt']}\n\n"
        "Put the final result on its own line in exactly this format:\n"
        "ANSWER: <final mathematical answer>"
    )


def run_batched_hf(job: dict[str, Any]) -> dict[str, Any]:
    """Official baseline path: pinned revisions + batched HF generate."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    # Import chat helper from sibling cuda package.
    import sys

    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts, template_fingerprint

    require_for_baseline(job)
    pin = verify_pinned()
    condition = CONDITIONS[job["conditionId"]]
    fields = matched_job_fields(condition)

    dataset_path = Path(job["datasetPath"]).resolve()
    if "locked" in str(dataset_path).split("/"):
        assert_can_read_locked_items(role=job.get("accessRole"), department_id=job.get("departmentId"))

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

    load_started = time.time()
    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"],
        revision=pin["tokenizerRevision"],
        trust_remote_code=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
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
    samples_per = int(fields["samplesPerProblem"])
    eval_started = time.time()
    peak_vram = None

    for start in range(0, len(pending), batch_size):
        if job.get("cancelFlagPath") and Path(job["cancelFlagPath"]).exists():
            break
        batch = pending[start : start + batch_size]
        for sample_index in range(samples_per):
            prompts = []
            for item in batch:
                user = build_user_prompt(item, few_shot=job.get("fewShotText"))
                prompt, _ = build_chat_texts(
                    tokenizer,
                    user,
                    None,
                    enable_thinking=bool(fields["enableThinking"]),
                )
                prompts.append(prompt)

            encoded = tokenizer(prompts, return_tensors="pt", padding=True)
            encoded = {key: value.to(device) for key, value in encoded.items()}
            gen_kwargs: dict[str, Any] = {
                "max_new_tokens": int(fields["maxNewTokens"]),
                "pad_token_id": tokenizer.pad_token_id,
                "eos_token_id": tokenizer.eos_token_id,
                "do_sample": bool(fields["doSample"]),
            }
            if fields["doSample"]:
                gen_kwargs["temperature"] = float(fields["temperature"])
                if fields.get("topP") is not None:
                    gen_kwargs["top_p"] = float(fields["topP"])
                if fields.get("topK") is not None:
                    gen_kwargs["top_k"] = int(fields["topK"])
                # Use first item seed as batch seed; per-item seeds recorded below.
                gen_kwargs["generator"] = torch.Generator(device=device)
                gen_kwargs["generator"].manual_seed(
                    sampling_seed_schedule(int(job.get("seed") or 18), start, sample_index),
                )

            with torch.no_grad():
                generated = model.generate(**encoded, **gen_kwargs)

            input_lens = encoded["attention_mask"].sum(dim=1).tolist()
            for row_index, item in enumerate(batch):
                in_len = int(input_lens[row_index])
                new_tokens = generated[row_index][in_len:]
                truncated = int(new_tokens.shape[0]) >= int(fields["maxNewTokens"])
                if tokenizer.eos_token_id is not None and tokenizer.eos_token_id in set(new_tokens.tolist()):
                    truncated = False
                text = tokenizer.decode(new_tokens, skip_special_tokens=True)
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
                    "samplingSeed": sampling_seed_schedule(int(job.get("seed") or 18), start + row_index, sample_index),
                    "rawPrediction": text,
                    "truncated": truncated,
                    "outcome": graded["outcome"],
                    "correct": graded["correct"],
                    "parsed": graded["parsed"],
                    "grade": graded["grade"],
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
    # Aggregate by first sample for pass@1; pass@3 if multiple samples.
    by_item: dict[str, list[dict[str, Any]]] = {}
    for row in results:
        by_item.setdefault(row["itemId"], []).append(row)

    pass1_correct = 0
    pass3_correct = 0
    outcomes = []
    for item_id, rows in by_item.items():
        rows = sorted(rows, key=lambda r: r["sampleIndex"])
        first = rows[0]
        outcomes.append(first["outcome"])
        if first["correct"]:
            pass1_correct += 1
        if any(r["correct"] for r in rows[:3]):
            pass3_correct += 1

    accounting = conservative_from_outcomes(outcomes)
    incomplete_families = []
    # Mark family incomplete if truncation dominates.
    family_trunc: dict[str, list[bool]] = {}
    for row in results:
        if row["sampleIndex"] == 0:
            family_trunc.setdefault(row["family"], []).append(bool(row["truncated"]))
    for family, flags in family_trunc.items():
        if flags and (sum(flags) / len(flags)) > 0.25:
            incomplete_families.append(family)

    report = {
        "ok": True,
        "specVersion": "c18d1-batched-eval-v1",
        "backend": "huggingface-batched",
        "vllmUsed": False,
        "vllmDeferredReason": "Use HF batched generate first; introduce vLLM only if needed and document VRAM impact.",
        "model": require_for_baseline({**job, **pin}),
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "conditionId": job["conditionId"],
        "decoding": fields,
        "datasetPath": str(dataset_path),
        "adapterPath": adapter_path,
        "batchSize": batch_size,
        "itemCount": len(by_item),
        "samplesPerProblem": samples_per,
        "passAt1": (pass1_correct / len(by_item)) if by_item else 0.0,
        "passAt3": (pass3_correct / len(by_item)) if by_item else 0.0,
        "accounting": accounting,
        "incompleteFamilies": incomplete_families,
        "timing": {
            "modelLoadMs": load_ms,
            "evalMs": eval_ms,
            "wallClockMs": load_ms + eval_ms,
        },
        "peakVramBytes": peak_vram,
        "ollamaTouched": False,
        "libraries": {
            "torch": getattr(__import__("torch"), "__version__", None),
            "transformers": getattr(__import__("transformers"), "__version__", None),
        },
        "aggregateForLearningAgents": redact_item_level(
            {
                "conditionId": job["conditionId"],
                "passAt1": (pass1_correct / len(by_item)) if by_item else 0.0,
                "passAt3": (pass3_correct / len(by_item)) if by_item else 0.0,
                "accounting": accounting,
                "incompleteFamilies": incomplete_families,
            },
        ),
    }
    _write_json(out / "eval-report.json", report)
    # Item-level artifacts stay under Evaluation storage path.
    _write_json(out / "item-results.json", {"access": "evaluation_only", "results": results})
    _write_json(ckpt_path, {"completedIds": sorted(done), "results": results, "partial": False})
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    # Default official pin into job if omitted (still fail-closed via require_for_baseline).
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key if key != "tokenizerRevision" else "tokenizerRevision"])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])
    try:
        report = run_batched_hf(job)
    except LockedTestAccessError as exc:
        raise SystemExit(f"ACCESS_DENIED: {exc}") from exc
    print(json.dumps({"ok": report["ok"], "passAt1": report["passAt1"], "outputDir": job["outputDir"]}, indent=2))


if __name__ == "__main__":
    main()
