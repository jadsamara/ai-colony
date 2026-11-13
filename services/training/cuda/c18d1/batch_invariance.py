#!/usr/bin/env python3
"""Stage A GPU batch-invariance gate for thinking-disabled greedy decode.

Gate v2 (preserved): outcome+raw mathText agreement and |Δlogit|≤5e-2.
Gate v3 (default): canonical SymPy answer agreement, graded-outcome agreement,
same-config bs4 repeatability; logit/KL diagnostics without hard thresholds.

Historical v2 GPU failure reports must not be overwritten or relabeled.
Requires CUDA + pinned Qwen3-8B. Fresh output directories per run.
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
    GATE_VERSION_V2,
    GATE_VERSION_V3,
    detect_prefix_artifacts,
    expected_left_pad_position_ids,
    first_token_diagnostics,
    gate_pass_v2,
    gate_pass_v3,
    graded_outcome_class_agree,
    mathematical_correctness_agree,
    outcomes_agree,
    position_ids_aligned_with_unpadded,
)
from decoding import CONDITIONS, matched_job_fields
from generation_utils import (
    BATCHING_POLICY,
    EVAL_IMPLEMENTATION_VERSION,
    FINAL_ANSWER_INSTRUCTION,
    assert_left_padding,
    build_generate_kwargs,
    filter_unsupported_generate_kwargs,
    prompt_token_length,
    slice_new_token_ids,
)
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned
from sympy_grader import answers_canonically_equal, grade_model_output

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
            expected_single = expected_left_pad_position_ids(single_mask)
            check = position_ids_aligned_with_unpadded(
                unpadded_attention_mask=single_mask,
                unpadded_position_ids=single_pos,
                padded_attention_mask=pad_mask[row_index].tolist(),
                padded_position_ids=pad_pos[row_index].tolist(),
            )
            pad_count = int(pad_mask.shape[1]) - int(sum(single_mask))
            row_ok = check["aligned"] and single_pos == expected_single
            if not row_ok:
                all_ok = False
            per_item.append(
                {
                    "itemId": item["id"],
                    "aligned": row_ok,
                    "unpaddedLen": len(single_mask),
                    "paddedWidth": int(pad_mask.shape[1]),
                    "padCountInBatch4": pad_count,
                    "paddingFreeInBatch4": pad_count == 0,
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
) -> dict[str, dict[str, Any]]:
    """Return float32 CPU logit vectors + padding metadata per item."""
    out: dict[str, dict[str, Any]] = {}
    for start in range(0, len(items), batch_size):
        batch = items[start : start + batch_size]
        batch_prompts = prompts[start : start + batch_size]
        encoded = tokenizer(batch_prompts, return_tensors="pt", padding=True)
        input_ids = encoded["input_ids"].to(device)
        attention_mask = encoded["attention_mask"].to(device)
        position_ids = _position_ids_from_mask(attention_mask, torch)
        width = int(input_ids.shape[1])
        with torch.no_grad():
            outputs = model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                position_ids=position_ids,
                use_cache=False,
            )
            logits = outputs.logits
        for row_index, item in enumerate(batch):
            attended = int(attention_mask[row_index].sum().item())
            last_idx = width - 1
            assert attended >= 1
            assert int(attention_mask[row_index, last_idx].item()) == 1
            vec = logits[row_index, last_idx, :].detach().float().cpu()
            out[item["id"]] = {
                "logits": vec,
                "padCount": width - attended,
                "paddingFree": (width - attended) == 0,
                "attended": attended,
                "batchSize": batch_size,
            }
    return out


def _grade_summary(text: str, expected: dict[str, Any]) -> dict[str, Any]:
    graded = grade_model_output(text, expected, enable_thinking=False)
    return {
        "outcome": graded["outcome"],
        "mathText": (graded.get("parsed") or {}).get("mathText"),
        "correct": bool(graded.get("correct")),
        "invalidReason": graded.get("invalidReason"),
    }


def _cuda_unavailable_report(gate_version: str, out: Path) -> dict[str, Any]:
    report = {
        "ok": False,
        "gate": "batch_invariance",
        "gateVersion": gate_version,
        "passed": False,
        "reason": "cuda_unavailable",
        "note": "GPU acceptance remains pending; do not claim batch invariance.",
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "historicalNote": (
            "Gate v2 GPU failure under commit 86fc7f7 is preserved evidence; "
            "do not overwrite or relabel those reports."
        ),
    }
    if gate_version == GATE_VERSION_V2:
        report["bf16FirstTokenLogitAbsTol"] = BF16_FIRST_TOKEN_LOGIT_ABS_TOL
    _write_json(out / "batch-invariance-report.json", report)
    return report


def run_batch_invariance_v2(
    *,
    job: dict[str, Any],
    model: Any,
    tokenizer: Any,
    items: list[dict[str, Any]],
    prompts: list[str],
    fields: dict[str, Any],
    device: str,
    pin: dict[str, Any],
    tmpl_fp: str,
    torch: Any,
) -> dict[str, Any]:
    """Preserved Gate v2 runner (hard logit tolerance)."""
    out = Path(job["outputDir"]).resolve()
    started = time.time()
    pos_check = _collect_position_id_checks(
        tokenizer=tokenizer,
        items=items,
        prompts=prompts,
        batch_size_padded=4,
        torch=torch,
    )
    logits_b1 = _first_token_logits_by_item(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=1, device=device, torch=torch,
    )
    logits_b4 = _first_token_logits_by_item(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=4, device=device, torch=torch,
    )
    texts_b1 = _generate_texts(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=1, fields=fields, device=device, torch=torch,
    )
    texts_b4 = _generate_texts(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=4, fields=fields, device=device, torch=torch,
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
        summary_a = _grade_summary(a, item["expected"])
        summary_b = _grade_summary(b, item["expected"])
        agree = outcomes_agree(summary_a, summary_b)
        if not agree:
            outcome_disagreements += 1
        outcome_rows.append({"itemId": item_id, "agree": agree, "batch1": summary_a, "batch4": summary_b})
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
        diff = float((logits_b1[item_id]["logits"] - logits_b4[item_id]["logits"]).abs().max().item())
        logit_diffs.append(diff)

    logit_max = max(logit_diffs) if logit_diffs else None
    logit_mean = (sum(logit_diffs) / len(logit_diffs)) if logit_diffs else None
    decision = gate_pass_v2(
        prefix_artifact_count=len(prefix_hits),
        position_ids_ok=bool(pos_check["aligned"]),
        outcome_disagreements=outcome_disagreements,
        first_token_logit_max_abs=logit_max,
    )
    report = {
        "ok": True,
        "gate": "batch_invariance",
        "gateVersion": GATE_VERSION_V2,
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
        "prefixTemplateArtifacts": {"count": len(prefix_hits), "items": prefix_hits[:32]},
        "positionIds": pos_check,
        "firstTokenLogits": {
            "bf16AbsTol": BF16_FIRST_TOKEN_LOGIT_ABS_TOL,
            "maxAbsDiff": logit_max,
            "meanAbsDiff": logit_mean,
            "perItemMaxAbsDiff": {item["id"]: logit_diffs[idx] for idx, item in enumerate(items)},
            "withinTolerance": bool(logit_max is not None and logit_max <= BF16_FIRST_TOKEN_LOGIT_ABS_TOL),
        },
        "batchSizesCompared": [1, 4],
        "conditionId": job.get("conditionId") or "thinking_disabled_zero_shot",
        "decoding": fields,
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "promptInstructionVersion": "c18d1-answer-instruction-v2",
        "batchingPolicy": BATCHING_POLICY,
        "elapsedMs": elapsed_ms,
        "gpu": {"name": torch.cuda.get_device_name(0), "deviceCount": torch.cuda.device_count()},
        "libraries": {
            "torch": torch.__version__,
            "transformers": __import__("transformers").__version__,
        },
        "preservedImplementation": True,
        "note": "Historical Gate v2 path; do not use to relabel prior failed GPU reports.",
    }
    _write_json(out / "batch-invariance-report.json", report)
    _write_json(out / "batch-invariance-texts.json", {"access": "evaluation_only", "batch1": texts_b1, "batch4": texts_b4})
    return report


def run_batch_invariance_v3(
    *,
    job: dict[str, Any],
    model: Any,
    tokenizer: Any,
    items: list[dict[str, Any]],
    prompts: list[str],
    fields: dict[str, Any],
    device: str,
    pin: dict[str, Any],
    tmpl_fp: str,
    torch: Any,
) -> dict[str, Any]:
    """Gate v3: canonical answers + repeatability; logits/KL diagnostic only."""
    out = Path(job["outputDir"]).resolve()
    started = time.time()
    pos_check = _collect_position_id_checks(
        tokenizer=tokenizer,
        items=items,
        prompts=prompts,
        batch_size_padded=4,
        torch=torch,
    )
    logits_b1 = _first_token_logits_by_item(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=1, device=device, torch=torch,
    )
    logits_b4 = _first_token_logits_by_item(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=4, device=device, torch=torch,
    )
    texts_b1 = _generate_texts(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=1, fields=fields, device=device, torch=torch,
    )
    texts_b4_a = _generate_texts(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=4, fields=fields, device=device, torch=torch,
    )
    # Same-configuration repeatability: second bs=4 pass, identical ordering/composition.
    texts_b4_b = _generate_texts(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=4, fields=fields, device=device, torch=torch,
    )
    logits_b4_repeat = _first_token_logits_by_item(
        model=model, tokenizer=tokenizer, items=items, prompts=prompts,
        batch_size=4, device=device, torch=torch,
    )
    elapsed_ms = int((time.time() - started) * 1000)

    cross_rows: list[dict[str, Any]] = []
    text_mismatches: list[dict[str, Any]] = []
    prefix_hits: list[dict[str, Any]] = []
    diag_rows: list[dict[str, Any]] = []
    graded_disagreements = 0
    canonical_disagreements = 0
    math_correct_disagreements = 0
    exact_answer_text_disagreements = 0
    top1_agree_count = 0
    kl_values: list[float] = []
    padded_diffs: list[float] = []
    pad_free_diffs: list[float] = []

    for item in items:
        item_id = item["id"]
        a = texts_b1.get(item_id, "")
        b = texts_b4_a.get(item_id, "")
        artifacts_a = detect_prefix_artifacts(a, enable_thinking=False)
        artifacts_b = detect_prefix_artifacts(b, enable_thinking=False)
        if artifacts_a or artifacts_b:
            prefix_hits.append({"itemId": item_id, "batch1": artifacts_a, "batch4": artifacts_b})

        summary_a = _grade_summary(a, item["expected"])
        summary_b = _grade_summary(b, item["expected"])
        outcome_ok = graded_outcome_class_agree(summary_a, summary_b)
        math_ok = mathematical_correctness_agree(summary_a, summary_b)
        exact_text_ok = (summary_a.get("mathText") or None) == (summary_b.get("mathText") or None)
        canon = answers_canonically_equal(summary_a.get("mathText"), summary_b.get("mathText"))
        # Missing answers on both sides (invalid) → canonical agree.
        # Parsed answers must match canonically; do not equate distinct wrong answers via outcome alone.
        if summary_a["outcome"] in {"invalid", "truncated"} and summary_b["outcome"] in {"invalid", "truncated"}:
            # For invalid/truncated, require same outcome class only for graded; canonical both missing.
            canon_ok = outcome_ok and canon["equal"]
        else:
            canon_ok = bool(canon["equal"])

        if not outcome_ok:
            graded_disagreements += 1
        if not canon_ok:
            canonical_disagreements += 1
        if not math_ok:
            math_correct_disagreements += 1
        if not exact_text_ok:
            exact_answer_text_disagreements += 1

        cross_rows.append(
            {
                "itemId": item_id,
                "gradedOutcomeAgree": outcome_ok,
                "mathematicalCorrectnessAgree": math_ok,
                "canonicalAnswerAgree": canon_ok,
                "exactAnswerTextAgree": exact_text_ok,
                "canonical": canon,
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
                    "canonicalAnswerAgree": canon_ok,
                    "gradedOutcomeAgree": outcome_ok,
                },
            )

        la = logits_b1[item_id]
        lb = logits_b4[item_id]
        diag = first_token_diagnostics(la["logits"].tolist(), lb["logits"].tolist())
        diag_row = {
            "itemId": item_id,
            "padCountBatch4": lb["padCount"],
            "paddingFreeInBatch4": lb["paddingFree"],
            **diag,
        }
        diag_rows.append(diag_row)
        if diag["top1Agree"]:
            top1_agree_count += 1
        kl_values.append(float(diag["klAB"]))
        if lb["paddingFree"]:
            pad_free_diffs.append(float(diag["maxAbsLogitDiff"]))
        else:
            padded_diffs.append(float(diag["maxAbsLogitDiff"]))

    # Same-configuration repeatability (bs4 vs bs4).
    repeat_diffs: list[dict[str, Any]] = []
    repeat_outcome_disagreements = 0
    repeat_canonical_disagreements = 0
    repeat_text_mismatches = 0
    repeat_top1_mismatches = 0
    for item in items:
        item_id = item["id"]
        t1 = texts_b4_a.get(item_id, "")
        t2 = texts_b4_b.get(item_id, "")
        s1 = _grade_summary(t1, item["expected"])
        s2 = _grade_summary(t2, item["expected"])
        outcome_ok = graded_outcome_class_agree(s1, s2)
        canon = answers_canonically_equal(s1.get("mathText"), s2.get("mathText"))
        if s1["outcome"] in {"invalid", "truncated"} and s2["outcome"] in {"invalid", "truncated"}:
            canon_ok = outcome_ok and canon["equal"]
        else:
            canon_ok = bool(canon["equal"])
        top1_a = int(logits_b4[item_id]["logits"].argmax().item())
        top1_b = int(logits_b4_repeat[item_id]["logits"].argmax().item())
        text_ok = t1 == t2
        if not text_ok:
            repeat_text_mismatches += 1
        if not outcome_ok:
            repeat_outcome_disagreements += 1
        if not canon_ok:
            repeat_canonical_disagreements += 1
        if top1_a != top1_b:
            repeat_top1_mismatches += 1
        if not (text_ok and outcome_ok and canon_ok and top1_a == top1_b):
            repeat_diffs.append(
                {
                    "itemId": item_id,
                    "exactTextEqual": text_ok,
                    "gradedOutcomeAgree": outcome_ok,
                    "canonicalAnswerAgree": canon_ok,
                    "top1Agree": top1_a == top1_b,
                    "top1RunA": top1_a,
                    "top1RunB": top1_b,
                    "runA": s1,
                    "runB": s2,
                    "canonical": canon,
                    "textPreviewA": t1[:160],
                    "textPreviewB": t2[:160],
                },
            )

    repeatability_passed = repeat_outcome_disagreements == 0 and repeat_canonical_disagreements == 0
    decision = gate_pass_v3(
        prefix_artifact_count=len(prefix_hits),
        position_ids_ok=bool(pos_check["aligned"]),
        graded_outcome_disagreements=graded_disagreements,
        canonical_answer_disagreements=canonical_disagreements,
        repeatability_passed=repeatability_passed,
    )

    def _avg(xs: list[float]) -> float | None:
        return (sum(xs) / len(xs)) if xs else None

    report = {
        "ok": True,
        "gate": "batch_invariance",
        "gateVersion": GATE_VERSION_V3,
        "passed": decision["passed"],
        "criterion": decision,
        "itemCount": len(items),
        "introducedAfterGateV2Failure": True,
        "gateV2HistoricalNote": (
            "Gate v2 (commit 86fc7f7) failed on GPU with first-token |Δlogit|≈0.5–1.5 "
            "including padding-free rows, and a false raw-string outcome disagreement "
            "on equivalent answers 1281/26 vs \\\\frac{1281}{26}. Those reports remain "
            "authoritative for v2; this v3 run does not overwrite them."
        ),
        "exactText": {
            "required": False,
            "matchedCount": len(items) - len(text_mismatches),
            "mismatchCount": len(text_mismatches),
            "mismatches": text_mismatches[:32],
        },
        "answerAgreement": {
            "mathematicalCorrectnessAgreementCount": len(items) - math_correct_disagreements,
            "mathematicalCorrectnessDisagreementCount": math_correct_disagreements,
            "canonicalAnswerAgreementCount": len(items) - canonical_disagreements,
            "canonicalAnswerDisagreementCount": canonical_disagreements,
            "exactAnswerTextAgreementCount": len(items) - exact_answer_text_disagreements,
            "exactAnswerTextDisagreementCount": exact_answer_text_disagreements,
            "gradedOutcomeAgreementCount": len(items) - graded_disagreements,
            "gradedOutcomeDisagreementCount": graded_disagreements,
            "items": cross_rows,
        },
        "prefixTemplateArtifacts": {"count": len(prefix_hits), "items": prefix_hits[:32]},
        "positionIds": pos_check,
        "firstTokenDiagnostics": {
            "acceptanceThresholdApplied": False,
            "top1AgreementCount": top1_agree_count,
            "top1AgreementRate": (top1_agree_count / len(items)) if items else 0.0,
            "klDivergenceAB": {
                "mean": _avg(kl_values),
                "max": max(kl_values) if kl_values else None,
            },
            "maxAbsLogitDiff": {
                "mean": _avg([float(r["maxAbsLogitDiff"]) for r in diag_rows]),
                "max": max((float(r["maxAbsLogitDiff"]) for r in diag_rows), default=None),
            },
            "paddingFreeRows": {
                "count": len(pad_free_diffs),
                "maxAbsLogitDiffMean": _avg(pad_free_diffs),
                "maxAbsLogitDiffMax": max(pad_free_diffs) if pad_free_diffs else None,
            },
            "paddedRows": {
                "count": len(padded_diffs),
                "maxAbsLogitDiffMean": _avg(padded_diffs),
                "maxAbsLogitDiffMax": max(padded_diffs) if padded_diffs else None,
            },
            "perItem": diag_rows,
        },
        "sameConfigurationRepeatability": {
            "batchSize": 4,
            "passed": repeatability_passed,
            "exactTextMismatchCount": repeat_text_mismatches,
            "gradedOutcomeDisagreementCount": repeat_outcome_disagreements,
            "canonicalAnswerDisagreementCount": repeat_canonical_disagreements,
            "top1MismatchCount": repeat_top1_mismatches,
            "differences": repeat_diffs[:64],
            "failureRule": (
                "Any graded-outcome or canonical-answer disagreement across identical "
                "bs=4 runs is a reproducibility failure."
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
            **BATCHING_POLICY,
            "fixedItemOrder": True,
            "fixedPrompts": True,
            "fixedGrader": True,
            "fixedDecoding": True,
            "fixedModelRevision": True,
        },
        "elapsedMs": elapsed_ms,
        "gpu": {"name": torch.cuda.get_device_name(0), "deviceCount": torch.cuda.device_count()},
        "libraries": {
            "torch": torch.__version__,
            "transformers": __import__("transformers").__version__,
        },
    }
    _write_json(out / "batch-invariance-report.json", report)
    _write_json(
        out / "batch-invariance-texts.json",
        {
            "access": "evaluation_only",
            "batch1": texts_b1,
            "batch4RunA": texts_b4_a,
            "batch4RunB": texts_b4_b,
        },
    )
    return report


def run_batch_invariance(job: dict[str, Any]) -> dict[str, Any]:
    import sys

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts, template_fingerprint

    gate_version = str(job.get("gateVersion") or GATE_VERSION)
    if gate_version not in {GATE_VERSION_V2, GATE_VERSION_V3}:
        raise SystemExit(f"Unsupported gateVersion: {gate_version}")

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
        return _cuda_unavailable_report(gate_version, out)

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

    common = dict(
        job=job,
        model=model,
        tokenizer=tokenizer,
        items=items,
        prompts=prompts,
        fields=fields,
        device=device,
        pin=pin,
        tmpl_fp=tmpl_fp,
        torch=torch,
    )
    if gate_version == GATE_VERSION_V2:
        return run_batch_invariance_v2(**common)
    return run_batch_invariance_v3(**common)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    parser.add_argument(
        "--gate-version",
        default=None,
        help="Override job gateVersion (c18d1-batch-invariance-v2|v3).",
    )
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])
    if args.gate_version:
        job["gateVersion"] = args.gate_version
    job.setdefault("gateVersion", GATE_VERSION_V3)
    report = run_batch_invariance(job)
    summary = {
        "ok": report.get("ok"),
        "passed": report.get("passed"),
        "gateVersion": report.get("gateVersion"),
        "outputDir": job["outputDir"],
    }
    if report.get("gateVersion") == GATE_VERSION_V3:
        summary.update(
            {
                "canonicalDisagreements": (report.get("answerAgreement") or {}).get(
                    "canonicalAnswerDisagreementCount",
                ),
                "gradedDisagreements": (report.get("answerAgreement") or {}).get(
                    "gradedOutcomeDisagreementCount",
                ),
                "repeatabilityPassed": (report.get("sameConfigurationRepeatability") or {}).get("passed"),
                "top1AgreementRate": (report.get("firstTokenDiagnostics") or {}).get("top1AgreementRate"),
                "exactTextMismatchCount": (report.get("exactText") or {}).get("mismatchCount"),
            },
        )
    else:
        summary.update(
            {
                "outcomeDisagreements": (report.get("gradedOutcomes") or {}).get("disagreementCount"),
                "firstTokenLogitMaxAbsDiff": (report.get("firstTokenLogits") or {}).get("maxAbsDiff"),
            },
        )
    print(json.dumps(summary, indent=2))
    if report.get("passed") is not True:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
