#!/usr/bin/env python3
"""One-time blind LLM disagreement audit for C1.8D (prepare + optional execute).

Default mode is **prepare-only**: writes blind packets and a runtime proposal.
Does not launch GPU workloads unless explicitly confirmed after approval.

Reviewer: Google Gemma 3 27B Instruct via local vLLM (family ≠ Qwen3).
LLM judgments are never ground truth and never authorize promotion.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
from collections import defaultdict
from pathlib import Path
from typing import Any

from answer_parser import GRADER_VERSION
from independent_check import independent_equals
from reviewer_gemma3 import (
    AUDIT_DESIGN,
    PROPOSED_REVIEWER,
    estimate_runtime,
    proposal_payload,
)

AUDIT_SPEC_VERSION = "c18d1-blind-llm-audit-v1"
# Historical API proposal retained for provenance only — not used.
PROPOSED_REVIEWER_PREVIOUS_API = {
    "provider": "openai",
    "modelId": "gpt-4o-mini",
    "modelFamily": "gpt",
    "supersededBy": "google/gemma-3-27b-it local vLLM",
}

BLIND_SYSTEM_PROMPT = """You are an independent mathematics answer auditor.
You will receive a problem statement and a model response.
Decide whether the model's final mathematical answer is correct for the problem.
Do NOT assume any prior grade. Respond with JSON only:
{
  "mathJudgment": "correct" | "incorrect" | "uncertain" | "insufficient_response",
  "formatCompliant": true | false,
  "briefRationale": "<one short sentence>"
}
formatCompliant means the response includes a clear final-answer marker such as ANSWER: or \\boxed{}.
"""


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_items(dataset_path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for line in dataset_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        out[str(item["id"])] = item
    return out


def estimate_cost(n_cases: int, reviewer: dict[str, Any] | None = None) -> dict[str, Any]:
    """Runtime/cost estimate for local Gemma reviewer (GPU-hours, not API $)."""
    rev = reviewer or PROPOSED_REVIEWER
    runtime = estimate_runtime(n_cases, rev)
    inp = rev["estimatedTokensPerCase"]["input"] * n_cases
    out = rev["estimatedTokensPerCase"]["output"] * n_cases
    return {
        **runtime,
        "estimatedInputTokens": inp,
        "estimatedOutputTokens": out,
        "estimatedUsd": 0.0,
        "supersedesApiProposal": PROPOSED_REVIEWER_PREVIOUS_API,
        "note": (
            "Local RTX PRO 6000 estimate — confirm after smoke validation. "
            "Do not launch GPU serve/audit until approved."
        ),
    }


def select_audit_cases(
    regrade_report: dict[str, Any],
    *,
    seed: int = 18,
    correct_sample_frac: float = 0.10,
) -> list[dict[str, Any]]:
    """Select all failures + high-risk transitions + stratified 10% of corrects."""
    rng = random.Random(seed)
    selected: list[dict[str, Any]] = []
    for cid, mode in (regrade_report.get("modes") or {}).items():
        if not mode.get("ok"):
            continue
        path = Path(mode["regradedPath"])
        rows = _load_json(path).get("results") or []
        enable_thinking = "thinking_enabled" in cid
        non_correct: list[dict[str, Any]] = []
        high_risk_correct: list[dict[str, Any]] = []
        correct_by_family: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            outcome = str(row.get("outcome") or "")
            fam = str(row.get("family") or "unknown")
            orig = str(row.get("originalOutcome") or "")
            meta = {
                "conditionId": cid,
                "enableThinking": enable_thinking,
                "itemId": row.get("itemId"),
                "family": fam,
                "sampleIndex": row.get("sampleIndex"),
                "regradedOutcome": outcome,
                "highRiskTransition": bool(orig and orig != outcome),
                "row": row,
            }
            if outcome in {"wrong", "invalid", "truncated", "grader_error"}:
                non_correct.append(meta)
            elif outcome == "correct":
                correct_by_family[fam].append(meta)
                # Include every original→corrected transition even if outside 10% sample.
                if meta["highRiskTransition"]:
                    high_risk_correct.append({**meta, "highRiskCorrect": True})
        selected.extend(non_correct)
        selected.extend(high_risk_correct)
        for fam, bucket in sorted(correct_by_family.items()):
            rng.shuffle(bucket)
            denom = len(bucket)
            k = max(1, int(round(denom * correct_sample_frac))) if bucket else 0
            for row in bucket[:k]:
                selected.append(
                    {
                        **row,
                        "correctSample": True,
                        "correctSampleDenominator": denom,
                        "correctSampleFrac": correct_sample_frac,
                    },
                )
    # Deduplicate by (conditionId, itemId, sampleIndex); prefer flags merged
    seen: dict[tuple[Any, ...], dict[str, Any]] = {}
    for case in selected:
        key = (case["conditionId"], case["itemId"], case.get("sampleIndex"))
        if key in seen:
            prev = seen[key]
            prev["correctSample"] = bool(prev.get("correctSample") or case.get("correctSample"))
            prev["highRiskTransition"] = bool(
                prev.get("highRiskTransition") or case.get("highRiskTransition"),
            )
            prev["highRiskCorrect"] = bool(prev.get("highRiskCorrect") or case.get("highRiskCorrect"))
            if case.get("correctSampleDenominator") is not None:
                prev["correctSampleDenominator"] = case["correctSampleDenominator"]
            if case.get("correctSampleFrac") is not None:
                prev["correctSampleFrac"] = case["correctSampleFrac"]
        else:
            seen[key] = dict(case)
    return list(seen.values())


def generation_identity(case: dict[str, Any]) -> tuple[Any, ...]:
    """Unique identity for one model generation in the audit."""
    return (case.get("conditionId"), case.get("itemId"), case.get("sampleIndex"))


def composition_summary(
    cases: list[dict[str, Any]],
    *,
    seed: int = 18,
    design_target: int | None = None,
    correct_sample_frac: float = 0.10,
) -> dict[str, Any]:
    """Summarize audit case composition for provenance / design checks."""
    design_target = (
        design_target if design_target is not None else AUDIT_DESIGN["expectedCaseCount"]
    )
    by_outcome: dict[str, int] = defaultdict(int)
    by_mode: dict[str, int] = defaultdict(int)
    by_family: dict[str, int] = defaultdict(int)
    failure_n = 0
    correct_sample_n = 0
    high_risk_n = 0
    high_risk_only_n = 0
    high_risk_and_sample_n = 0
    identities = [generation_identity(c) for c in cases]
    unique_n = len(set(identities))
    for c in cases:
        outcome = str(c.get("regradedOutcome") or "")
        by_outcome[outcome] += 1
        by_mode[str(c.get("conditionId"))] += 1
        by_family[str(c.get("family"))] += 1
        if outcome in {"wrong", "invalid", "truncated", "grader_error"}:
            failure_n += 1
        is_sample = bool(c.get("correctSample"))
        is_hr = bool(c.get("highRiskTransition"))
        if is_sample:
            correct_sample_n += 1
        if is_hr:
            high_risk_n += 1
        if is_hr and is_sample:
            high_risk_and_sample_n += 1
        if is_hr and not is_sample and outcome == "correct":
            high_risk_only_n += 1

    # Denominator for stratified 10%: regraded-correct rows per family × mode
    # (computed from selected correctSample flags' sibling buckets at select time).
    # Report the effective selected counts; denominators are recorded when available
    # on case metadata (`correctSampleDenominator`).
    denominators: dict[str, int] = {}
    for c in cases:
        if not c.get("correctSample"):
            continue
        key = f"{c.get('conditionId')}::{c.get('family')}"
        denom = c.get("correctSampleDenominator")
        if denom is not None:
            denominators[key] = int(denom)

    delta = len(cases) - design_target
    explanation = (
        f"Design target {design_target} ≈ all failures + stratified "
        f"{correct_sample_frac:.0%} of regraded corrects. "
        f"Actual {len(cases)} includes every high-risk original→corrected "
        f"transition even when outside the 10% sample "
        f"({high_risk_only_n} exclusive high-risk corrects after dedup). "
        f"Failures included: {failure_n}. "
        f"High-risk ∩ correct-sample overlap: {high_risk_and_sample_n}. "
        f"Unique generation identities: {unique_n}/{len(cases)}. "
        f"Selection seed={seed}."
    )
    return {
        "caseCount": len(cases),
        "designTarget": design_target,
        "deltaVsDesign": delta,
        "failureCount": failure_n,
        "correctSampleCount": correct_sample_n,
        "highRiskTransitionCount": high_risk_n,
        "exclusiveHighRiskCorrectCount": high_risk_only_n,
        "highRiskAndCorrectSampleOverlapCount": high_risk_and_sample_n,
        "uniqueGenerationIdentityCount": unique_n,
        "allGenerationIdentitiesUnique": unique_n == len(cases),
        "byRegradedOutcome": dict(sorted(by_outcome.items())),
        "byCondition": dict(sorted(by_mode.items())),
        "byFamily": dict(sorted(by_family.items())),
        "includesAllFailures": True,  # enforced by select_audit_cases
        "correctSampleFracTarget": correct_sample_frac,
        "correctSampleDenominatorsByConditionFamily": denominators,
        "correctSampleDenominatorDefinition": (
            "Per (conditionId, family): count of regraded outcome=correct rows; "
            "k = max(1, round(denom * 0.10)) sampled with Random(seed)."
        ),
        "seed": seed,
        "reproducibleWithSeed": True,
        "explanation": explanation,
        "blindReviewerPayload": ["problemStatement", "rawModelResponse"],
    }


def assert_blind_packet(packet: dict[str, Any]) -> list[str]:
    """Return issues if expected answers / grades leak into blind reviewer fields."""
    issues: list[str] = []
    blind = packet.get("blind") or {}
    forbidden_blind_keys = {
        "expected",
        "regradedOutcome",
        "originalOutcome",
        "correct",
        "grade",
        "graderVersion",
        "hidden",
        "independentTruth",
    }
    leak = forbidden_blind_keys.intersection(blind)
    if leak:
        issues.append(f"blind_keys_leak:{sorted(leak)}")
    # Serialized blind payload must not embed expected JSON / outcome labels as fields
    blind_blob = json.dumps(blind, sort_keys=True)
    for needle in ('"expected"', '"regradedOutcome"', '"originalOutcome"', '"independentTruth"'):
        if needle in blind_blob:
            issues.append(f"blind_json_contains:{needle}")
    hidden = packet.get("hidden") or {}
    if "expected" not in hidden:
        issues.append("hidden_missing_expected")
    prompt = packet.get("reviewerPrompt") or {}
    user_t = str(prompt.get("userTemplate") or "")
    if "{expected}" in user_t or "regradedOutcome" in user_t:
        issues.append("user_template_references_grades")
    return issues


def reviewer_user_message(packet: dict[str, Any]) -> str:
    """Build the exact user message sent to Gemma (blind fields only)."""
    blind = packet["blind"]
    tmpl = (packet.get("reviewerPrompt") or {}).get("userTemplate") or (
        "Problem:\n{problem}\n\nModel response:\n{response}\n\n"
        "Return JSON with mathJudgment, formatCompliant, briefRationale."
    )
    return tmpl.format(
        problem=blind["problemStatement"],
        response=blind["rawModelResponse"],
    )


def verify_dataset_prompt_provenance(
    dataset_path: Path,
    packets: list[dict[str, Any]],
) -> dict[str, Any]:
    """Confirm audit packets join to dataset prompts (saved prompt provenance)."""
    items = _load_items(dataset_path)
    missing = []
    prompt_mismatch = []
    empty_prompt = []
    for p in packets:
        iid = str(p.get("itemId"))
        item = items.get(iid)
        if item is None:
            missing.append(iid)
            continue
        prompt = item.get("prompt")
        if not prompt or not str(prompt).strip():
            empty_prompt.append(iid)
            continue
        blind_prompt = (p.get("blind") or {}).get("problemStatement")
        if blind_prompt and blind_prompt != "<missing prompt>" and blind_prompt != prompt:
            prompt_mismatch.append(iid)
    digest = hashlib.sha256(dataset_path.read_bytes()).hexdigest()
    return {
        "ok": not missing and not prompt_mismatch and not empty_prompt,
        "datasetPath": str(dataset_path.resolve()),
        "datasetSha256": digest,
        "packetCount": len(packets),
        "itemIndexSize": len(items),
        "missingItemIds": missing[:32],
        "emptyPromptItemIds": empty_prompt[:32],
        "promptMismatchItemIds": prompt_mismatch[:32],
        "lockedDataAccessed": "locked" in {p.lower() for p in dataset_path.resolve().parts},
    }


def build_blind_packet(case: dict[str, Any], item: dict[str, Any] | None) -> dict[str, Any]:
    row = case["row"]
    packet_id = hashlib.sha256(
        f"{case['conditionId']}:{case['itemId']}:{case.get('sampleIndex')}".encode(),
    ).hexdigest()[:16]
    return {
        "packetId": packet_id,
        "conditionId": case["conditionId"],
        "itemId": case["itemId"],
        "family": case["family"],
        "sampleIndex": case.get("sampleIndex"),
        "correctSample": bool(case.get("correctSample")),
        "highRiskTransition": bool(case.get("highRiskTransition")),
        "blind": {
            "problemStatement": (item or {}).get("prompt") or "<missing prompt>",
            "rawModelResponse": row.get("rawPrediction") or "",
        },
        # Hidden until after reviewer judgment (stored separately for scoring).
        "hidden": {
            "regradedOutcome": row.get("outcome"),
            "originalOutcome": row.get("originalOutcome"),
            "expected": row.get("expectedUsed") or (item or {}).get("expected"),
            "graderVersion": row.get("graderVersion") or GRADER_VERSION,
        },
        "reviewerPrompt": {
            "system": BLIND_SYSTEM_PROMPT,
            "userTemplate": (
                "Problem:\n{problem}\n\nModel response:\n{response}\n\n"
                "Return JSON with mathJudgment, formatCompliant, briefRationale."
            ),
        },
    }


# Operator-reported Gemma smoke (BF16) — used to calibrate full-audit runtime.
SMOKE_OBSERVED_METRICS = {
    "agreeCount": 12,
    "parseOkCount": 12,
    "caseCount": 12,
    "meanLatencyMs": 2215,
    "startupSeconds": 74,
    "gpuMemoryGiBApprox": 80.6,
    "passed": True,
    "dtype": "bfloat16",
    "modelRevision": "005ad3404e59d6023443cb575daa05336842228a",
}


def estimate_runtime_from_smoke(
    n_cases: int = 307,
    *,
    smoke: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Serial runtime from measured smoke latency + startup (conservative)."""
    s = smoke or SMOKE_OBSERVED_METRICS
    mean_ms = float(s.get("meanLatencyMs") or 2500)
    startup_s = float(s.get("startupSeconds") or 240)
    gen_s = n_cases * (mean_ms / 1000.0)
    total_s = startup_s + gen_s
    base = estimate_runtime(n_cases)
    return {
        **base,
        "calibration": "gemma_smoke_observed",
        "smokeObserved": s,
        "estimatedSecondsPerCaseSerial": round(mean_ms / 1000.0, 3),
        "estimatedStartupSeconds": startup_s,
        "estimatedGenerationMinutesSerial": round(gen_s / 60.0, 1),
        "estimatedTotalGpuMinutesSerial": round(total_s / 60.0, 1),
        "estimatedGpuHoursSerial": round(total_s / 3600.0, 2),
        "diskEstimate": {
            "modelWeightsGiBCached": 54,
            "auditOutputMiB": 50,
            "recommendedFreeGiB": 5,
            "note": (
                "Reuse existing HF cache for pinned revision; do not redownload. "
                "Confirm free disk on GPU VM before serve."
            ),
        },
    }


def prepare_audit(
    *,
    regrade_report_path: Path,
    dataset_path: Path,
    output_dir: Path,
    seed: int = 18,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    report = _load_json(regrade_report_path)
    items = _load_items(dataset_path)
    cases = select_audit_cases(report, seed=seed)
    packets = []
    blindness_issues: list[dict[str, Any]] = []
    for case in cases:
        item = items.get(str(case["itemId"]))
        packet = build_blind_packet(case, item)
        issues = assert_blind_packet(packet)
        if issues:
            blindness_issues.append({"packetId": packet["packetId"], "issues": issues})
        # Strip hidden from any export that could be sent to the model API path.
        packets.append(packet)
    composition = composition_summary(cases, seed=seed)
    provenance = verify_dataset_prompt_provenance(dataset_path, packets)
    cost = estimate_cost(len(packets))
    runtime = estimate_runtime_from_smoke(len(packets) or AUDIT_DESIGN["expectedCaseCount"])
    gemma_proposal = proposal_payload()
    blindness_ok = len(blindness_issues) == 0
    # Design target 307 is typical full-dev; record actual + target.
    composition["expectedCaseCountDesign"] = AUDIT_DESIGN["expectedCaseCount"]
    composition["matchesDesignTarget"] = (
        composition["caseCount"] == AUDIT_DESIGN["expectedCaseCount"]
    )
    manifest = {
        "ok": blindness_ok and provenance.get("ok", False),
        "auditSpecVersion": AUDIT_SPEC_VERSION,
        "auditDesign": AUDIT_DESIGN,
        "mode": "prepare_only",
        "seed": seed,
        "packetCount": len(packets),
        "expectedCaseCount": AUDIT_DESIGN["expectedCaseCount"],
        "composition": composition,
        "datasetProvenance": provenance,
        "blindness": {
            "ok": blindness_ok,
            "issueCount": len(blindness_issues),
            "issues": blindness_issues[:32],
            "reviewerSeesOnly": ["problemStatement", "rawModelResponse"],
            "reviewerDoesNotSee": list(AUDIT_DESIGN["blindTo"]),
        },
        "proposedReviewer": PROPOSED_REVIEWER,
        "costEstimate": cost,
        "runtimeEstimate": runtime,
        "smokeObserved": SMOKE_OBSERVED_METRICS,
        "gemmaServingProposal": gemma_proposal,
        "systemPrompt": BLIND_SYSTEM_PROMPT,
        "executeGate": (
            "1) Smoke validation passed (12/12). "
            "2) Review composition + reconcile + runtime/disk. "
            "3) Set C18D1_LLM_AUDIT_CONFIRM=1 for GPU full-audit script. "
            "No GPU workload is launched from prepare-only."
        ),
        "policy": [
            "Do not reveal expected answers or grades before initial judgment",
            "LLM judgments are not ground truth",
            "Disagreements adjudicated with SymPy / independent_check",
            "Unresolved disagreements escalate to human review",
            "Does not authorize promotion",
            "Reuse pinned Gemma HF cache; do not redownload weights",
            "Exit Qwen vLLM fully before loading Gemma; tear down after audit",
        ],
        "regradeReportPath": str(regrade_report_path.resolve()),
        "datasetPath": str(dataset_path.resolve()),
        "graderVersion": GRADER_VERSION,
        "gpuWorkloadAuthorized": False,
        "fullAuditExecuted": False,
    }
    (output_dir / "blind-audit-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "blind-packets.jsonl").write_text(
        "\n".join(json.dumps(p, sort_keys=True) for p in packets) + ("\n" if packets else ""),
        encoding="utf-8",
    )
    # Blind-only export for the model API (no hidden / grades).
    blind_only = [
        {
            "packetId": p["packetId"],
            "conditionId": p["conditionId"],
            "itemId": p["itemId"],
            "family": p["family"],
            "sampleIndex": p.get("sampleIndex"),
            "blind": p["blind"],
            "system": BLIND_SYSTEM_PROMPT,
            "user": reviewer_user_message(p),
        }
        for p in packets
    ]
    for bo in blind_only:
        # Defense in depth: refuse if user message somehow embeds hidden fields.
        if '"expected"' in bo["user"] or "regradedOutcome" in bo["user"]:
            raise RuntimeError(f"blind user message leaked grades for {bo['packetId']}")
    (output_dir / "blind-packets-for-reviewer.jsonl").write_text(
        "\n".join(json.dumps(p, sort_keys=True) for p in blind_only) + ("\n" if blind_only else ""),
        encoding="utf-8",
    )
    # Hidden labels file kept separate so reviewers can be given packets only.
    hidden = [
        {
            "packetId": p["packetId"],
            "itemId": p["itemId"],
            "conditionId": p["conditionId"],
            "hidden": p["hidden"],
            "correctSample": p.get("correctSample"),
            "highRiskTransition": p.get("highRiskTransition"),
        }
        for p in packets
    ]
    (output_dir / "blind-hidden-labels.json").write_text(
        json.dumps(hidden, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "audit-composition.json").write_text(
        json.dumps(composition, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def score_judgment(packet: dict[str, Any], judgment: dict[str, Any]) -> dict[str, Any]:
    """Compare reviewer judgment to corrected deterministic grade; verify with exact math.

    Disagreement detection is **symmetric** for the binary pairs:
    (reviewer correct, grader wrong) and (reviewer incorrect, grader correct).

    ``independentEqual`` is ``None`` when the candidate is not independently
    comparable — never coerce non-comparable cases to ``False``.
    """
    hidden = packet["hidden"]
    math_j = str(judgment.get("mathJudgment") or "")
    regraded = str(hidden.get("regradedOutcome") or "")
    expected = hidden.get("expected") or {}
    raw = packet["blind"]["rawModelResponse"]
    problem = (packet.get("blind") or {}).get("problemStatement")
    # Extract candidate via independent check when possible
    from independent_check import extract_candidate

    enable = "thinking_enabled" in str(packet.get("conditionId"))
    extracted = extract_candidate(raw, enable_thinking=enable)
    if extracted.get("ok"):
        eq = independent_equals(extracted.get("mathText"), expected, prompt=problem)
    else:
        eq = {"equal": None, "comparable": False, "reason": extracted.get("reason")}

    # Map judgments — both disagreement directions share this predicate.
    reviewer_says_correct = math_j == "correct"
    det_correct = regraded == "correct"
    disagreement = None
    if math_j in {"correct", "incorrect"} and regraded in {"correct", "wrong"}:
        disagreement = reviewer_says_correct != det_correct

    comparable = bool(eq.get("comparable"))
    equal = eq.get("equal") if comparable else None

    # Grader FP/FN candidates require a decisive independent comparison.
    grader_fp = bool(det_correct and comparable and equal is False)
    grader_fn = bool((not det_correct) and comparable and equal is True)

    # Symmetric reviewer-vs-exact conflicts (only when comparable).
    reviewer_vs_exact = None
    if comparable and math_j in {"correct", "incorrect"}:
        if math_j == "correct" and equal is False:
            reviewer_vs_exact = "reviewer_correct_but_exact_unequal"
        elif math_j == "incorrect" and equal is True:
            reviewer_vs_exact = "reviewer_incorrect_but_exact_equal"

    return {
        "packetId": packet["packetId"],
        "itemId": packet["itemId"],
        "reviewerMathJudgment": math_j,
        "reviewerFormatCompliant": judgment.get("formatCompliant"),
        "regradedOutcome": regraded,
        "disagreementWithDeterministic": disagreement,
        "independentEqual": equal,
        "independentComparable": comparable,
        "graderFalsePositiveCandidate": grader_fp,
        "graderFalseNegativeCandidate": grader_fn,
        # Legacy boolean kept for older consumers (reviewer incorrect + exact equal).
        "reviewerVsExactConflict": bool(
            det_correct and math_j == "incorrect" and comparable and equal is True,
        ),
        "reviewerVsExactConflictKind": reviewer_vs_exact,
        "escalation": (
            "human_review"
            if disagreement and not comparable
            else ("none" if not disagreement else "exact_check_applied")
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--regrade-report", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=18)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Launch reviewer calls (requires C18D1_LLM_AUDIT_CONFIRM=1).",
    )
    args = parser.parse_args()
    manifest = prepare_audit(
        regrade_report_path=args.regrade_report,
        dataset_path=args.dataset,
        output_dir=args.out,
        seed=args.seed,
    )
    print(json.dumps({"ok": True, "prepare": manifest["costEstimate"], "out": str(args.out)}, indent=2))
    if not args.execute:
        print("[c18d1] prepare-only complete — STOP for cost/model approval before --execute")
        return
    if os.environ.get("C18D1_LLM_AUDIT_CONFIRM") != "1":
        raise SystemExit(
            "Refusing --execute without C18D1_LLM_AUDIT_CONFIRM=1 "
            f"(proposed {manifest['costEstimate']})",
        )
    raise SystemExit(
        "Execute path intentionally gated after proposal approval. "
        "Serve Gemma per reviewer_gemma3.vllm_serve_command(), run smoke "
        "validation first, then score blind-packets.jsonl. "
        "See gemmaServingProposal + runtimeEstimate in blind-audit-manifest.json. "
        "Do not treat Gemma judgments as ground truth.",
    )


if __name__ == "__main__":
    main()
