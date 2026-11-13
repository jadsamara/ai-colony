#!/usr/bin/env python3
"""Stage A GPU batch-invariance gate for thinking-disabled greedy decode.

Runs the same development items at batch_size=1 and batch_size=4 and requires
exact generated-text equality per item. Accuracy-score agreement alone fails.

Requires CUDA + pinned Qwen3-8B. Writes a report; does not overwrite prior pilots.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from decoding import CONDITIONS, matched_job_fields
from generation_utils import (
    EVAL_IMPLEMENTATION_VERSION,
    FINAL_ANSWER_INSTRUCTION,
    assert_left_padding,
    build_generate_kwargs,
    filter_unsupported_generate_kwargs,
    prompt_token_length,
    slice_new_token_ids,
)
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned

ROOT = Path(__file__).resolve().parent


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _generate_texts(
    *,
    model: Any,
    tokenizer: Any,
    items: list[dict[str, Any]],
    batch_size: int,
    fields: dict[str, Any],
    device: str,
    enable_thinking: bool,
    torch: Any,
    build_chat_texts: Any,
) -> dict[str, str]:
    texts: dict[str, str] = {}
    gen_kwargs = filter_unsupported_generate_kwargs(
        build_generate_kwargs(
            fields=fields,
            pad_token_id=tokenizer.pad_token_id,
            eos_token_id=tokenizer.eos_token_id,
        ),
    )
    for start in range(0, len(items), batch_size):
        batch = items[start : start + batch_size]
        prompts = []
        for item in batch:
            user = f"{item['prompt']}\n\n{FINAL_ANSWER_INSTRUCTION}"
            prompt, _ = build_chat_texts(
                tokenizer,
                user,
                None,
                enable_thinking=enable_thinking,
            )
            prompts.append(prompt)
        encoded = tokenizer(prompts, return_tensors="pt", padding=True)
        encoded = {key: value.to(device) for key, value in encoded.items()}
        prompt_len = prompt_token_length(int(encoded["input_ids"].shape[1]))
        with torch.no_grad():
            generated = model.generate(**encoded, **gen_kwargs)
        for row_index, item in enumerate(batch):
            new_tokens = slice_new_token_ids(generated[row_index], prompt_len)
            texts[item["id"]] = tokenizer.decode(new_tokens, skip_special_tokens=True)
    return texts


def run_batch_invariance(job: dict[str, Any]) -> dict[str, Any]:
    import sys

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts, template_fingerprint

    require_for_baseline(job)
    pin = verify_pinned()
    condition = CONDITIONS[job.get("conditionId") or "thinking_disabled_zero_shot"]
    if condition["doSample"] or condition["enableThinking"]:
        raise SystemExit("Batch-invariance gate requires thinking-disabled greedy decoding.")
    fields = matched_job_fields(condition)

    dataset_path = Path(job["datasetPath"]).resolve()
    items = _load_jsonl(dataset_path)
    if job.get("limit"):
        items = items[: int(job["limit"])]

    out = Path(job["outputDir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    device = job.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
    if device != "cuda" or not torch.cuda.is_available():
        report = {
            "ok": False,
            "gate": "batch_invariance",
            "passed": False,
            "reason": "cuda_unavailable",
            "note": "GPU acceptance remains pending; do not claim batch invariance.",
            "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        }
        _write_json(out / "batch-invariance-report.json", report)
        return report

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
        torch_dtype=torch.bfloat16,
    )
    model.to(device)
    model.eval()
    tmpl_fp = template_fingerprint(tokenizer)

    started = time.time()
    texts_b1 = _generate_texts(
        model=model,
        tokenizer=tokenizer,
        items=items,
        batch_size=1,
        fields=fields,
        device=device,
        enable_thinking=False,
        torch=torch,
        build_chat_texts=build_chat_texts,
    )
    texts_b4 = _generate_texts(
        model=model,
        tokenizer=tokenizer,
        items=items,
        batch_size=4,
        fields=fields,
        device=device,
        enable_thinking=False,
        torch=torch,
        build_chat_texts=build_chat_texts,
    )
    elapsed_ms = int((time.time() - started) * 1000)

    mismatches: list[dict[str, Any]] = []
    for item in items:
        item_id = item["id"]
        a = texts_b1.get(item_id, "")
        b = texts_b4.get(item_id, "")
        if a != b:
            mismatches.append(
                {
                    "itemId": item_id,
                    "batch1Preview": a[:240],
                    "batch4Preview": b[:240],
                    "batch1Len": len(a),
                    "batch4Len": len(b),
                },
            )

    passed = len(mismatches) == 0
    report = {
        "ok": True,
        "gate": "batch_invariance",
        "passed": passed,
        "criterion": "exact_generated_text_match",
        "itemCount": len(items),
        "matchedCount": len(items) - len(mismatches),
        "mismatchCount": len(mismatches),
        "mismatches": mismatches[:32],
        "batchSizesCompared": [1, 4],
        "conditionId": job.get("conditionId") or "thinking_disabled_zero_shot",
        "decoding": fields,
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "promptInstructionVersion": "c18d1-answer-instruction-v2",
        "elapsedMs": elapsed_ms,
        "gpu": {
            "name": torch.cuda.get_device_name(0),
            "deviceCount": torch.cuda.device_count(),
        },
        "libraries": {
            "torch": torch.__version__,
            "transformers": __import__("transformers").__version__,
        },
        "investigationHintsIfFailed": [
            "padding_side must be left; slice at input_ids.shape[1]",
            "check position_ids / attention_mask alignment",
            "check nondeterministic CUDA kernels / TF32 settings",
        ],
    }
    _write_json(out / "batch-invariance-report.json", report)
    _write_json(
        out / "batch-invariance-texts.json",
        {"access": "evaluation_only", "batch1": texts_b1, "batch4": texts_b4},
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])
    report = run_batch_invariance(job)
    print(json.dumps({"ok": report.get("ok"), "passed": report.get("passed"), "mismatchCount": report.get("mismatchCount"), "outputDir": job["outputDir"]}, indent=2))
    if report.get("passed") is not True:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
