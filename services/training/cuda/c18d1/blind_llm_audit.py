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
    """Select wrong/invalid/truncated/ambiguous + stratified 10% of corrects."""
    rng = random.Random(seed)
    selected: list[dict[str, Any]] = []
    for cid, mode in (regrade_report.get("modes") or {}).items():
        if not mode.get("ok"):
            continue
        path = Path(mode["regradedPath"])
        rows = _load_json(path).get("results") or []
        enable_thinking = "thinking_enabled" in cid
        non_correct = []
        correct_by_family: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            outcome = str(row.get("outcome") or "")
            fam = str(row.get("family") or "unknown")
            meta = {
                "conditionId": cid,
                "enableThinking": enable_thinking,
                "itemId": row.get("itemId"),
                "family": fam,
                "sampleIndex": row.get("sampleIndex"),
                "regradedOutcome": outcome,
                "row": row,
            }
            if outcome in {"wrong", "invalid", "truncated", "grader_error"}:
                non_correct.append(meta)
            elif outcome == "correct":
                correct_by_family[fam].append(meta)
            # Ambiguous / transitions of interest
            if str(row.get("originalOutcome")) != outcome:
                meta = {**meta, "highRiskTransition": True}
                if meta not in non_correct and outcome == "correct":
                    # still eligible via correct sample; mark high-risk separately
                    pass
        selected.extend(non_correct)
        for fam, bucket in sorted(correct_by_family.items()):
            rng.shuffle(bucket)
            k = max(1, int(round(len(bucket) * correct_sample_frac))) if bucket else 0
            for row in bucket[:k]:
                row = {**row, "correctSample": True}
                selected.append(row)
    # Deduplicate by (conditionId, itemId, sampleIndex)
    seen: set[tuple[Any, ...]] = set()
    uniq: list[dict[str, Any]] = []
    for case in selected:
        key = (case["conditionId"], case["itemId"], case.get("sampleIndex"))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(case)
    return uniq


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
    for case in cases:
        item = items.get(str(case["itemId"]))
        packets.append(build_blind_packet(case, item))
    cost = estimate_cost(len(packets))
    gemma_proposal = proposal_payload()
    manifest = {
        "ok": True,
        "auditSpecVersion": AUDIT_SPEC_VERSION,
        "auditDesign": AUDIT_DESIGN,
        "mode": "prepare_only",
        "seed": seed,
        "packetCount": len(packets),
        "expectedCaseCount": AUDIT_DESIGN["expectedCaseCount"],
        "proposedReviewer": PROPOSED_REVIEWER,
        "costEstimate": cost,
        "runtimeEstimate": cost,
        "gemmaServingProposal": gemma_proposal,
        "systemPrompt": BLIND_SYSTEM_PROMPT,
        "executeGate": (
            "1) Approve Gemma BF16 serving proposal + runtime estimate. "
            "2) Pass smoke validation (12 verified packets). "
            "3) Set C18D1_LLM_AUDIT_CONFIRM=1 for --execute. "
            "No GPU workload is launched otherwise."
        ),
        "policy": [
            "Do not reveal expected answers or grades before initial judgment",
            "LLM judgments are not ground truth",
            "Disagreements adjudicated with SymPy / independent_check",
            "Unresolved disagreements escalate to human review",
            "Does not authorize promotion",
            "Exit Qwen vLLM fully before loading Gemma; tear down after audit",
        ],
        "regradeReportPath": str(regrade_report_path.resolve()),
        "datasetPath": str(dataset_path.resolve()),
        "graderVersion": GRADER_VERSION,
        "gpuWorkloadAuthorized": False,
    }
    (output_dir / "blind-audit-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "blind-packets.jsonl").write_text(
        "\n".join(json.dumps(p, sort_keys=True) for p in packets) + ("\n" if packets else ""),
        encoding="utf-8",
    )
    # Hidden labels file kept separate so reviewers can be given packets only.
    hidden = [
        {
            "packetId": p["packetId"],
            "itemId": p["itemId"],
            "conditionId": p["conditionId"],
            "hidden": p["hidden"],
        }
        for p in packets
    ]
    (output_dir / "blind-hidden-labels.json").write_text(
        json.dumps(hidden, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def score_judgment(packet: dict[str, Any], judgment: dict[str, Any]) -> dict[str, Any]:
    """Compare reviewer judgment to corrected deterministic grade; verify with exact math."""
    hidden = packet["hidden"]
    math_j = str(judgment.get("mathJudgment") or "")
    regraded = str(hidden.get("regradedOutcome") or "")
    expected = hidden.get("expected") or {}
    raw = packet["blind"]["rawModelResponse"]
    # Extract candidate via independent check when possible
    from independent_check import extract_candidate

    enable = "thinking_enabled" in str(packet.get("conditionId"))
    extracted = extract_candidate(raw, enable_thinking=enable)
    eq = independent_equals(extracted.get("mathText"), expected) if extracted.get("ok") else {
        "equal": False,
        "comparable": False,
    }

    # Map judgments
    reviewer_says_correct = math_j == "correct"
    det_correct = regraded == "correct"
    disagreement = None
    if math_j in {"correct", "incorrect"} and regraded in {"correct", "wrong"}:
        disagreement = reviewer_says_correct != det_correct

    fp = bool(det_correct and math_j == "incorrect" and eq.get("comparable") and eq.get("equal"))
    # FP for grader: grader said correct but math is wrong — need reviewer incorrect + eq unequal
    grader_fp = bool(det_correct and eq.get("comparable") and (eq.get("equal") is False))
    grader_fn = bool((not det_correct) and eq.get("comparable") and eq.get("equal"))

    return {
        "packetId": packet["packetId"],
        "itemId": packet["itemId"],
        "reviewerMathJudgment": math_j,
        "reviewerFormatCompliant": judgment.get("formatCompliant"),
        "regradedOutcome": regraded,
        "disagreementWithDeterministic": disagreement,
        "independentEqual": eq.get("equal"),
        "independentComparable": eq.get("comparable"),
        "graderFalsePositiveCandidate": grader_fp,
        "graderFalseNegativeCandidate": grader_fn,
        "reviewerVsExactConflict": fp,
        "escalation": (
            "human_review"
            if disagreement and not eq.get("comparable")
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
