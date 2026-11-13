#!/usr/bin/env python3
"""Stage A GPU batch-invariance gate for thinking-disabled greedy decode.

Compares batch_size=1 vs batch_size=4 on the same development items.

Pass criteria (v2):
- no prefix/template artifacts in decoded generations
- position_ids for padded rows match the unpadded run
- graded outcome (+ parsed math answer) agree on every item
- first generated-token logit max-abs-diff within bf16 noise tolerance

Exact generated-text equality is reported but not required.

Requires CUDA + pinned Qwen3-8B. Writes a report; does not overwrite prior pilots.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from batch_invariance_metrics import (
    BF16_FIRST_TOKEN_LOGIT_ABS_TOL,
    GATE_VERSION,
    detect_prefix_artifacts,
    expected_left_pad_position_ids,
    gate_pass,
    outcomes_agree,
    position_ids_aligned_with_unpadded,
)
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
from sympy_grader import grade_model_output

ROOT = Path(__file__).resolve().parent


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _build_prompts(items: list[dict[str, Any]], tokenizer: Any, build_chat_texts: Any) -> list[str]:
    prompts: list[str] = []
    for item in items:
        user = f"{item['prompt']}\n\n{FINAL_ANSWER_INSTRUCTION}"
        prompt, _ = build_chat_texts(
            tokenizer,
            user,
            None,
            enable_thinking=False,
        )
        prompts.append(prompt)
    return prompts


def _position_ids_from_mask(attention_mask: Any, torch: Any) -> Any:
    """Transformers-style positions: cumsum(mask)-1 with pads → 0."""
    position_ids = attention_mask.long().cumsum(dim=-1) - 1
    position_ids = position_ids.masked_fill(attention_mask == 0, 0)
    return position_ids


def _generate_texts(
    *,
    model: Any,
    tokenizer: Any,
    items: list[dict[str, Any]],
    prompts: list[str],
    batch_size: int,
    fields: dict[str, Any],
    device: str,
    torch: Any,
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
        batch_prompts = prompts[start : start + batch_size]
        encoded = tokenizer(batch_prompts, return_tensors="pt", padding=True)
        encoded = {key: value.to(device) for key, value in encoded.items()}
        prompt_len = prompt_token_length(int(encoded["input_ids"].shape[1]))
        with torch.no_grad():
            generated = model.generate(**encoded, **gen_kwargs)
        for row_index, item in enumerate(batch):
            new_tokens = slice_new_token_ids(generated[row_index], prompt_len)
            texts[item["id"]] = tokenizer.decode(new_tokens, skip_special_tokens=True)
    return texts


def _collect_position_id_checks(
    *,
    tokenizer: Any,
    items: list[dict[str, Any]],
    prompts: list[str],
    batch_size_padded: int,
    torch: Any,
) -> dict[str, Any]:
    """Compare position ids for each item in unpadded vs padded batch encoding."""
    per_item: list[dict[str, Any]] = []
    all_ok = True
    for start in range(0, len(items), batch_size_padded):
        batch = items[start : start + batch_size_padded]
        batch_prompts = prompts[start : start + batch_size_padded]
        padded = tokenizer(batch_prompts, return_tensors="pt", padding=True)
        pad_mask = padded["attention_mask"]
        pad_pos = _position_ids_from_mask(pad_mask, torch)
        for row_index, item in enumerate(batch):
            single = tokenizer([batch_prompts[row_index]], return_tensors="pt", padding=False)
            single_mask = single["attention_mask"][0].tolist()
            single_pos = _position_ids_from_mask(single["attention_mask"], torch)[0].tolist()
            # Also verify against our expected helper (defense in depth).
            expected_single = expected_left_pad_position_ids(single_mask)
            check = position_ids_aligned_with_unpadded(
                unpadded_attention_mask=single_mask,
                unpadded_position_ids=single_pos,
                padded_attention_mask=pad_mask[row_index].tolist(),
                padded_position_ids=pad_pos[row_index].tolist(),
            )
            row_ok = check["aligned"] and single_pos == expected_single
            if not row_ok:
                all_ok = False
            per_item.append(
                {
                    "itemId": item["id"],
                    "aligned": row_ok,
                    "unpaddedLen": len(single_mask),
                    "paddedWidth": int(pad_mask.shape[1]),
                    "contentPositions": check["paddedContent"],
                },
            )
    return {"aligned": all_ok, "items": per_item, "method": "cumsum(attention_mask)-1, pads→0"}


def _first_token_logits_by_item(
    *,
    model: Any,
    tokenizer: Any,
    items: list[dict[str, Any]],
    prompts: list[str],
    batch_size: int,
    device: str,
    torch: Any,
) -> dict[str, Any]:
    """Return float32 CPU logit vectors for the next-token distribution per item."""
    out: dict[str, Any] = {}
    for start in range(0, len(items), batch_size):
        batch = items[start : start + batch_size]
        batch_prompts = prompts[start : start + batch_size]
        encoded = tokenizer(batch_prompts, return_tensors="pt", padding=True)
        input_ids = encoded["input_ids"].to(device)
        attention_mask = encoded["attention_mask"].to(device)
        position_ids = _position_ids_from_mask(attention_mask, torch)
        with torch.no_grad():
            outputs = model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                position_ids=position_ids,
                use_cache=False,
            )
            logits = outputs.logits  # [B, T, V]
        for row_index, item in enumerate(batch):
            # Last attended token predicts the first generated token.
            attended = int(attention_mask[row_index].sum().item())
            # With left padding, last content index is always the final column.
            last_idx = int(input_ids.shape[1]) - 1
            # Sanity: attended tokens end at last_idx when left-padded.
            assert attended >= 1
            assert int(attention_mask[row_index, last_idx].item()) == 1
            vec = logits[row_index, last_idx, :].detach().float().cpu()
            out[item["id"]] = vec
    return out


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
            "gateVersion": GATE_VERSION,
            "passed": False,
            "reason": "cuda_unavailable",
            "note": "GPU acceptance remains pending; do not claim batch invariance.",
            "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
            "bf16FirstTokenLogitAbsTol": BF16_FIRST_TOKEN_LOGIT_ABS_TOL,
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
    prompts = _build_prompts(items, tokenizer, build_chat_texts)

    started = time.time()
    pos_check = _collect_position_id_checks(
        tokenizer=tokenizer,
        items=items,
        prompts=prompts,
        batch_size_padded=4,
        torch=torch,
    )
    logits_b1 = _first_token_logits_by_item(
        model=model,
        tokenizer=tokenizer,
        items=items,
        prompts=prompts,
        batch_size=1,
        device=device,
        torch=torch,
    )
    logits_b4 = _first_token_logits_by_item(
        model=model,
        tokenizer=tokenizer,
        items=items,
        prompts=prompts,
        batch_size=4,
        device=device,
        torch=torch,
    )
    texts_b1 = _generate_texts(
        model=model,
        tokenizer=tokenizer,
        items=items,
        prompts=prompts,
        batch_size=1,
        fields=fields,
        device=device,
        torch=torch,
    )
    texts_b4 = _generate_texts(
        model=model,
        tokenizer=tokenizer,
        items=items,
        prompts=prompts,
        batch_size=4,
        fields=fields,
        device=device,
        torch=torch,
    )
    elapsed_ms = int((time.time() - started) * 1000)

    text_mismatches: list[dict[str, Any]] = []
    outcome_rows: list[dict[str, Any]] = []
    outcome_disagreements = 0
    prefix_hits: list[dict[str, Any]] = []
    logit_diffs: list[float] = []

    for item in items:
        item_id = item["id"]
        a = texts_b1.get(item_id, "")
        b = texts_b4.get(item_id, "")
        artifacts_a = detect_prefix_artifacts(a, enable_thinking=False)
        artifacts_b = detect_prefix_artifacts(b, enable_thinking=False)
        if artifacts_a or artifacts_b:
            prefix_hits.append({"itemId": item_id, "batch1": artifacts_a, "batch4": artifacts_b})

        graded_a = grade_model_output(a, item["expected"], enable_thinking=False)
        graded_b = grade_model_output(b, item["expected"], enable_thinking=False)
        summary_a = {
            "outcome": graded_a["outcome"],
            "mathText": (graded_a.get("parsed") or {}).get("mathText"),
            "correct": graded_a.get("correct"),
        }
        summary_b = {
            "outcome": graded_b["outcome"],
            "mathText": (graded_b.get("parsed") or {}).get("mathText"),
            "correct": graded_b.get("correct"),
        }
        agree = outcomes_agree(summary_a, summary_b)
        if not agree:
            outcome_disagreements += 1
        outcome_rows.append(
            {
                "itemId": item_id,
                "agree": agree,
                "batch1": summary_a,
                "batch4": summary_b,
            },
        )

        if a != b:
            text_mismatches.append(
                {
                    "itemId": item_id,
                    "batch1Preview": a[:240],
                    "batch4Preview": b[:240],
                    "batch1Len": len(a),
                    "batch4Len": len(b),
                    "outcomeAgree": agree,
                },
            )

        la = logits_b1[item_id]
        lb = logits_b4[item_id]
        diff = float((la - lb).abs().max().item())
        logit_diffs.append(diff)

    logit_max = max(logit_diffs) if logit_diffs else None
    logit_mean = (sum(logit_diffs) / len(logit_diffs)) if logit_diffs else None

    decision = gate_pass(
        prefix_artifact_count=len(prefix_hits),
        position_ids_ok=bool(pos_check["aligned"]),
        outcome_disagreements=outcome_disagreements,
        first_token_logit_max_abs=logit_max,
    )

    report = {
        "ok": True,
        "gate": "batch_invariance",
        "gateVersion": GATE_VERSION,
        "passed": decision["passed"],
        "criterion": decision,
        "itemCount": len(items),
        "exactText": {
            "required": False,
            "matchedCount": len(items) - len(text_mismatches),
            "mismatchCount": len(text_mismatches),
            "mismatches": text_mismatches[:32],
        },
        "gradedOutcomes": {
            "agreementCount": len(items) - outcome_disagreements,
            "disagreementCount": outcome_disagreements,
            "items": outcome_rows,
        },
        "prefixTemplateArtifacts": {
            "count": len(prefix_hits),
            "items": prefix_hits[:32],
        },
        "positionIds": pos_check,
        "firstTokenLogits": {
            "bf16AbsTol": BF16_FIRST_TOKEN_LOGIT_ABS_TOL,
            "maxAbsDiff": logit_max,
            "meanAbsDiff": logit_mean,
            "perItemMaxAbsDiff": {
                item["id"]: logit_diffs[idx] for idx, item in enumerate(items)
            },
            "withinTolerance": bool(
                logit_max is not None and logit_max <= BF16_FIRST_TOKEN_LOGIT_ABS_TOL
            ),
        },
        "batchSizesCompared": [1, 4],
        "conditionId": job.get("conditionId") or "thinking_disabled_zero_shot",
        "decoding": fields,
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "promptInstructionVersion": "c18d1-answer-instruction-v2",
        "batchingPolicy": {
            "batchSizeFixedPerEvalConfig": True,
            "batchCompositionFixedPerEvalConfig": True,
            "baseAndAdapterIdenticalBatching": True,
            "note": (
                "Greedy wording can change with batch shape (bf16 near-ties). "
                "Official comparisons fix batch size and composition and use the "
                "same batching for base and adapter."
            ),
        },
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
            "graded outcome disagreement implies batch shape affects answers",
            f"first-token logit abs diff must be <= {BF16_FIRST_TOKEN_LOGIT_ABS_TOL}",
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
    print(
        json.dumps(
            {
                "ok": report.get("ok"),
                "passed": report.get("passed"),
                "gateVersion": report.get("gateVersion"),
                "exactTextMismatchCount": (report.get("exactText") or {}).get("mismatchCount"),
                "outcomeDisagreements": (report.get("gradedOutcomes") or {}).get("disagreementCount"),
                "firstTokenLogitMaxAbsDiff": (report.get("firstTokenLogits") or {}).get("maxAbsDiff"),
                "outputDir": job["outputDir"],
            },
            indent=2,
        ),
    )
    if report.get("passed") is not True:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
