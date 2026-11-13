#!/usr/bin/env python3
"""vLLM same-config repeatability + cross-submit invariance diagnostics.

vLLM continuous batching varies batch composition. This gate reports whether
same-config repeatability passes for greedy and fixed-seed sampled modes.
vLLM is NOT eligible as the official backend unless repeatability passes.

Does not overwrite HF Gate v3 evidence. Development items only.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from batch_invariance_metrics import GATE_VERSION_V3, detect_prefix_artifacts
from decoding import CONDITIONS, matched_job_fields
from generation_utils import EVAL_IMPLEMENTATION_VERSION, OFFICIAL_BACKEND
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned
from dev_provenance import DevelopmentProvenanceError, assert_authorized_development_dataset
from stratified_selection import dataset_content_hash
from sympy_grader import answers_canonically_equal, grade_model_output
from vllm_backend import BACKEND_ID, BACKEND_STATUS, build_prompts, generate_texts_vllm, load_vllm_engine

ROOT = Path(__file__).resolve().parent


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _summarize(text: str, expected: dict[str, Any], *, enable_thinking: bool) -> dict[str, Any]:
    graded = grade_model_output(text, expected, enable_thinking=enable_thinking)
    return {
        "outcome": graded["outcome"],
        "mathText": (graded.get("parsed") or {}).get("mathText"),
        "correct": bool(graded.get("correct")),
        "finalText": (graded.get("parsed") or {}).get("finalText"),
        "invalidReason": graded.get("invalidReason"),
    }


def _compare_runs(
    items: list[dict[str, Any]],
    texts_a: list[str],
    texts_b: list[str],
    *,
    enable_thinking: bool,
) -> dict[str, Any]:
    diffs: list[dict[str, Any]] = []
    outcome_dis = 0
    canon_dis = 0
    text_mis = 0
    prefix = 0
    for item, a, b in zip(items, texts_a, texts_b):
        sa = _summarize(a, item["expected"], enable_thinking=enable_thinking)
        sb = _summarize(b, item["expected"], enable_thinking=enable_thinking)
        arts = detect_prefix_artifacts(a, enable_thinking=enable_thinking) + detect_prefix_artifacts(
            b, enable_thinking=enable_thinking,
        )
        if arts:
            prefix += 1
        outcome_ok = sa["outcome"] == sb["outcome"]
        canon = answers_canonically_equal(sa.get("mathText"), sb.get("mathText"))
        if sa["outcome"] in {"invalid", "truncated"} and sb["outcome"] in {"invalid", "truncated"}:
            canon_ok = outcome_ok and canon["equal"]
        else:
            canon_ok = bool(canon["equal"])
        text_ok = a == b
        if not text_ok:
            text_mis += 1
        if not outcome_ok:
            outcome_dis += 1
        if not canon_ok:
            canon_dis += 1
        if not (text_ok and outcome_ok and canon_ok):
            diffs.append(
                {
                    "itemId": item["id"],
                    "exactTextEqual": text_ok,
                    "gradedOutcomeAgree": outcome_ok,
                    "canonicalAnswerAgree": canon_ok,
                    "runA": sa,
                    "runB": sb,
                    "prefixArtifacts": arts,
                    "finalResponseAfterThinkA": (sa.get("finalText") or "")[:1500],
                    "finalResponseAfterThinkB": (sb.get("finalText") or "")[:1500],
                },
            )
    passed = outcome_dis == 0 and canon_dis == 0 and prefix == 0
    return {
        "passed": passed,
        "itemCount": len(items),
        "exactTextMismatchCount": text_mis,
        "gradedOutcomeDisagreementCount": outcome_dis,
        "canonicalAnswerDisagreementCount": canon_dis,
        "prefixArtifactItemCount": prefix,
        "differences": diffs[:64],
        "failureRule": (
            "Any graded-outcome or canonical-answer disagreement is a reproducibility failure. "
            "Exact text mismatches are reported but do not alone fail this check."
        ),
    }


def run_vllm_repeatability(job: dict[str, Any]) -> dict[str, Any]:
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

    condition_id = job.get("conditionId") or "thinking_disabled_zero_shot"
    condition = CONDITIONS[condition_id]
    fields = matched_job_fields(condition)
    if job.get("maxNewTokens"):
        fields = {**fields, "maxNewTokens": int(job["maxNewTokens"])}

    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"], revision=pin["tokenizerRevision"], trust_remote_code=True,
    )
    tmpl_fp = template_fingerprint(tokenizer)
    prompts = build_prompts(
        items, tokenizer,
        enable_thinking=bool(fields["enableThinking"]),
        build_chat_texts=build_chat_texts,
    )
    seed = int(job.get("seed") or 18)

    started = time.time()
    try:
        llm = load_vllm_engine(pin)
    except Exception as exc:  # noqa: BLE001
        report = {
            "ok": False,
            "passed": False,
            "backend": BACKEND_ID,
            "backendStatus": BACKEND_STATUS,
            "officialBackend": OFFICIAL_BACKEND,
            "eligibleAsOfficialBackend": False,
            "reason": f"vllm_load_failed: {type(exc).__name__}: {exc}",
            "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
            "gateReference": GATE_VERSION_V3,
        }
        _write_json(out / "vllm-repeatability-report.json", report)
        return report

    # Mode A: greedy same-config (submit full list twice)
    greedy_fields = {**fields, "doSample": False, "temperature": 0.0}
    run_a = generate_texts_vllm(
        llm=llm, prompts=prompts, fields=greedy_fields,
        base_seed=seed, item_indices=list(range(len(items))), sample_index=0,
    )
    run_b = generate_texts_vllm(
        llm=llm, prompts=prompts, fields=greedy_fields,
        base_seed=seed, item_indices=list(range(len(items))), sample_index=0,
    )
    greedy_cmp = _compare_runs(
        items,
        [r["text"] for r in run_a],
        [r["text"] for r in run_b],
        enable_thinking=bool(fields["enableThinking"]),
    )

    # Mode B: one-at-a-time vs all-at-once (batch composition diagnostic)
    one_texts: list[str] = []
    for idx, prompt in enumerate(prompts):
        one = generate_texts_vllm(
            llm=llm, prompts=[prompt], fields=greedy_fields,
            base_seed=seed, item_indices=[idx], sample_index=0,
        )
        one_texts.append(one[0]["text"])
    cross_cmp = _compare_runs(
        items,
        one_texts,
        [r["text"] for r in run_a],
        enable_thinking=bool(fields["enableThinking"]),
    )

    # Mode C: sampled with fixed per-request seeds (same config twice)
    sampled_fields = matched_job_fields(CONDITIONS["thinking_enabled_zero_shot"])
    if job.get("maxNewTokens"):
        sampled_fields = {**sampled_fields, "maxNewTokens": int(job["maxNewTokens"])}
    # Keep thinking mode from job condition for prompts already built; for sampled
    # invariance of decoding, rebuild prompts if thinking differs.
    if bool(sampled_fields["enableThinking"]) != bool(fields["enableThinking"]):
        sampled_prompts = build_prompts(
            items, tokenizer,
            enable_thinking=True,
            build_chat_texts=build_chat_texts,
        )
    else:
        sampled_prompts = prompts
    s_a = generate_texts_vllm(
        llm=llm, prompts=sampled_prompts, fields=sampled_fields,
        base_seed=seed, item_indices=list(range(len(items))), sample_index=0,
    )
    s_b = generate_texts_vllm(
        llm=llm, prompts=sampled_prompts, fields=sampled_fields,
        base_seed=seed, item_indices=list(range(len(items))), sample_index=0,
    )
    sampled_cmp = _compare_runs(
        items,
        [r["text"] for r in s_a],
        [r["text"] for r in s_b],
        enable_thinking=True,
    )

    elapsed_ms = int((time.time() - started) * 1000)
    eligible = bool(greedy_cmp["passed"] and sampled_cmp["passed"])
    report = {
        "ok": True,
        "backend": BACKEND_ID,
        "backendStatus": BACKEND_STATUS,
        "officialBackend": OFFICIAL_BACKEND,
        "eligibleAsOfficialBackend": eligible,
        "eligibilityRule": (
            "vLLM eligible as official only if greedy and fixed-seed sampled "
            "same-config repeatability both pass (graded outcomes + canonical answers)."
        ),
        "passed": eligible,
        "gateReference": GATE_VERSION_V3,
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "pinned": pin,
        "templateFingerprint": tmpl_fp,
        "datasetPath": str(dataset_path),
        "datasetContentHash": dataset_content_hash(items),
        "developmentProvenance": provenance,
        "itemCount": len(items),
        "seed": seed,
        "greedySameConfigRepeatability": greedy_cmp,
        "oneAtATimeVsBatchedSubmit": {
            **cross_cmp,
            "note": (
                "Diagnostic of continuous-batching composition effects; "
                "not alone decisive for official eligibility."
            ),
        },
        "sampledFixedSeedSameConfigRepeatability": sampled_cmp,
        "elapsedMs": elapsed_ms,
        "historicalNote": (
            "HF Gate v3 PASS evidence is preserved separately; this report does not overwrite it."
        ),
    }
    _write_json(out / "vllm-repeatability-report.json", report)
    _write_json(
        out / "vllm-repeatability-texts.json",
        {
            "access": "evaluation_only",
            "greedyRunA": [r["text"] for r in run_a],
            "greedyRunB": [r["text"] for r in run_b],
            "oneAtATime": one_texts,
            "sampledRunA": [r["text"] for r in s_a],
            "sampledRunB": [r["text"] for r in s_b],
        },
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
    report = run_vllm_repeatability(job)
    print(
        json.dumps(
            {
                "ok": report.get("ok"),
                "passed": report.get("passed"),
                "eligibleAsOfficialBackend": report.get("eligibleAsOfficialBackend"),
                "outputDir": job["outputDir"],
            },
            indent=2,
        ),
    )
    if report.get("passed") is not True:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
