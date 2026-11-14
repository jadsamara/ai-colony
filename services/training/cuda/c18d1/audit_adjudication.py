#!/usr/bin/env python3
"""CPU-only post-audit adjudication for C1.8D Gemma blind-audit results.

Consumes an existing ``gemma-full-audit-report.json`` (no GPU, no new inference).
Does not modify official grades. Gemma judgments are never ground truth.

Adjudication version: c18d1-audit-adjudication-v1
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from answer_parser import GRADER_VERSION
from blind_llm_audit import score_judgment
from exact_repr import correct_expected, strip_correction_metadata
from gemma_full_audit_runner import classify_disagreement
from independent_check import extract_candidate, independent_equals

ADJUDICATION_VERSION = "c18d1-audit-adjudication-v1"
DESIGN_PACKET_COUNT = 325

_REFUSAL = re.compile(
    r"(?is)\b(i\s+can'?t|i\s+cannot|unable\s+to|as\s+an\s+ai|refuse|not\s+able\s+to\s+help)\b",
)
_DOMAIN = re.compile(r"(?is)\b(domain|extraneous|undefined|x\s*>\s*0|positive|argument)\b")
_APPROX = re.compile(r"(?is)\b(approx|approximately|≈|~=|decimal|float)\b")
_REASONING_FOCUS = re.compile(
    r"(?is)\b(reasoning|steps?\s+(are|look)\s+correct|work\s+is\s+correct|method\s+is)\b",
)


def load_audit_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def classify_parse_failure(result: dict[str, Any]) -> dict[str, Any]:
    """Taxonomy for reviewer JSON parse failures (no new inference)."""
    parsed = result.get("parsed") or {}
    resp = result.get("response") or {}
    raw = resp.get("rawContent")
    err = resp.get("error")
    reason = str(parsed.get("reason") or "")

    if err:
        kind = "transport_or_api_error"
        detail = str(err)
    elif not raw or not str(raw).strip():
        kind = "empty_response"
        detail = reason or "empty"
    elif _REFUSAL.search(str(raw)):
        kind = "refusal_or_policy"
        detail = reason or "refusal_language"
    elif reason in {"json_block_invalid"}:
        kind = "malformed_json"
        detail = reason
    elif reason in {"no_json"}:
        # May be truncation mid-JSON or prose-only
        text = str(raw)
        if text.count("{") > text.count("}"):
            kind = "truncated_json"
            detail = "unbalanced_braces"
        else:
            kind = "no_json_object"
            detail = reason
    else:
        kind = "unparseable_other"
        detail = reason or "unknown"

    return {
        "packetId": result.get("packetId"),
        "itemId": result.get("itemId"),
        "conditionId": result.get("conditionId"),
        "family": result.get("family"),
        "sampleIndex": result.get("sampleIndex"),
        "parseFailureKind": kind,
        "detail": detail,
        "rawPreview": (str(raw)[:400] if raw else None),
        "responseError": err,
        "parsedReason": reason or None,
    }


def _rationale_text(result: dict[str, Any]) -> str:
    j = result.get("judgment") or {}
    return str(j.get("briefRationale") or "")


def analyze_exp_log_hints(result: dict[str, Any], *, expected: dict[str, Any] | None) -> dict[str, Any]:
    """Heuristic flags for exponential/log disagreements (not definitive)."""
    blind = result.get("blindPacket") or {}
    problem = str(blind.get("problemStatement") or "")
    raw = str(blind.get("rawModelResponse") or "")
    rationale = _rationale_text(result)
    hints = {
        "mentionsDomainOrExtraneous": bool(_DOMAIN.search(problem + "\n" + raw + "\n" + rationale)),
        "mentionsApproximation": bool(_APPROX.search(raw + "\n" + rationale)),
        "rationaleFocusesOnReasoning": bool(_REASONING_FOCUS.search(rationale)),
        "expectedKind": (expected or {}).get("kind"),
    }
    return hints


def deeper_independent_check(
    result: dict[str, Any],
) -> dict[str, Any]:
    """Re-run independent extraction/equality with prompt-aware exact expected.

    Numerical approximations alone are never treated as definitive proof.
    """
    blind = result.get("blindPacket") or {}
    hidden = result.get("hidden") or {}
    raw = str(blind.get("rawModelResponse") or "")
    problem = str(blind.get("problemStatement") or "")
    expected = hidden.get("expected") or {}
    enable = "thinking_enabled" in str(result.get("conditionId") or "")
    truncated = bool((result.get("score") or {}).get("truncated"))  # may be absent

    extracted = extract_candidate(raw, enable_thinking=enable, truncated=truncated)
    if not extracted.get("ok") or not extracted.get("mathText"):
        return {
            "comparable": False,
            "equal": None,
            "resolved": False,
            "resolution": "unresolved_no_extractable_candidate",
            "extractedMathText": None,
            "reason": extracted.get("reason") or "no_extractable_answer",
            "definitive": False,
        }

    eq = independent_equals(
        extracted.get("mathText"),
        expected,
        prompt=problem or None,
    )
    comparable = bool(eq.get("comparable"))
    equal = eq.get("equal") if comparable else None
    if comparable and equal is True:
        resolution = "independent_confirms_equal_to_expected"
        resolved = True
        definitive = True
    elif comparable and equal is False:
        resolution = "independent_confirms_unequal_to_expected"
        resolved = True
        definitive = True
    else:
        resolution = "unresolved_not_independently_comparable"
        resolved = False
        definitive = False

    return {
        "comparable": comparable,
        "equal": equal,
        "resolved": resolved,
        "resolution": resolution,
        "extractedMathText": extracted.get("mathText"),
        "reason": eq.get("reason"),
        "gradeDetail": eq.get("gradeDetail"),
        "expectedUsed": eq.get("expectedUsed"),
        "definitive": definitive,
        "note": (
            "Symbolic/canonical equality only. Decimal approximations are not "
            "treated as definitive proof of correctness."
        ),
    }


def adjudicate_disagreement(result: dict[str, Any]) -> dict[str, Any]:
    """Classify one disagreement without treating independentEqual=false as Gemma error."""
    score = result.get("score") or {}
    judgment = result.get("judgment") or {}
    hidden = result.get("hidden") or {}
    dclass = result.get("disagreementClass") or classify_disagreement(
        score,
        judgment if judgment else None,
    )
    deeper = deeper_independent_check(result)
    family = str(result.get("family") or "unknown")
    rationale = _rationale_text(result)
    math_j = str(judgment.get("mathJudgment") or score.get("reviewerMathJudgment") or "")
    regraded = str(hidden.get("regradedOutcome") or score.get("regradedOutcome") or "")

    direction = None
    if math_j == "correct" and regraded == "wrong":
        direction = "reviewer_correct_vs_grader_wrong"
    elif math_j == "incorrect" and regraded == "correct":
        direction = "reviewer_incorrect_vs_grader_correct"
    else:
        direction = f"other:{math_j}_vs_{regraded}"

    # Adjudication labels — never "gemma_error" solely from independentEqual false.
    if deeper["resolved"] and deeper["equal"] is False and direction == "reviewer_correct_vs_grader_wrong":
        if _REASONING_FOCUS.search(rationale):
            label = "reviewer_may_have_scored_reasoning_not_final_answer"
            confidence = "medium"
        else:
            label = "exact_check_supports_grader_model_answer_unequal"
            confidence = "high"
        human = False
    elif deeper["resolved"] and deeper["equal"] is True and direction == "reviewer_correct_vs_grader_wrong":
        label = "exact_check_supports_reviewer_possible_grader_false_negative"
        confidence = "high"
        human = True  # still needs human before any grader change
    elif deeper["resolved"] and deeper["equal"] is True and direction == "reviewer_incorrect_vs_grader_correct":
        label = "exact_check_supports_grader_reviewer_false_negative"
        confidence = "high"
        human = False
    elif deeper["resolved"] and deeper["equal"] is False and direction == "reviewer_incorrect_vs_grader_correct":
        label = "exact_check_supports_reviewer_possible_grader_false_positive"
        confidence = "high"
        human = True
    else:
        label = "unresolved_needs_human_adjudication"
        confidence = "low"
        human = True

    exp_hints = None
    if family == "exponential_log_equations":
        exp_hints = analyze_exp_log_hints(result, expected=hidden.get("expected"))
        if exp_hints["mentionsDomainOrExtraneous"] and human:
            label = "unresolved_domain_or_extraneous_root_risk"
        if exp_hints["mentionsApproximation"] and deeper.get("equal") is not True:
            # Soften confidence — approx mentions must not alone confirm
            if label.startswith("exact_check_supports_grader"):
                confidence = "medium"
                label = "exact_check_unequal_but_approx_language_present"

    return {
        "packetId": result.get("packetId"),
        "itemId": result.get("itemId"),
        "conditionId": result.get("conditionId"),
        "family": family,
        "sampleIndex": result.get("sampleIndex"),
        "generationIdentity": {
            "conditionId": result.get("conditionId"),
            "itemId": result.get("itemId"),
            "sampleIndex": result.get("sampleIndex"),
        },
        "disagreementClass": dclass,
        "direction": direction,
        "reviewerMathJudgment": math_j,
        "regradedOutcome": regraded,
        "reviewerRationale": rationale,
        "auditIndependentEqual": score.get("independentEqual"),
        "auditIndependentComparable": score.get("independentComparable"),
        "deeperCheck": deeper,
        "adjudicationLabel": label,
        "confidence": confidence,
        "needsHumanReview": human,
        "exponentialLogHints": exp_hints,
        "officialGradeModified": False,
        "problemStatement": (result.get("blindPacket") or {}).get("problemStatement"),
        "rawModelResponse": (result.get("blindPacket") or {}).get("rawModelResponse"),
        "expected": hidden.get("expected"),
        "gemmaJudgment": judgment,
        "provenance": {
            "graderVersionHidden": hidden.get("graderVersion"),
            "correctSample": result.get("correctSample"),
            "highRiskTransition": result.get("highRiskTransition"),
            "adjudicationVersion": ADJUDICATION_VERSION,
        },
    }


def verify_score_judgment_symmetry() -> dict[str, Any]:
    """Executable check that disagreement detection is symmetric in both directions."""
    packet_base = {
        "packetId": "sym-test",
        "itemId": "sym-item",
        "conditionId": "thinking_disabled_zero_shot",
        "blind": {
            "problemStatement": "Solve x=2",
            "rawModelResponse": "ANSWER: 2",
        },
        "hidden": {
            "expected": {"kind": "roots", "values": ["2"]},
        },
    }
    # Reviewer correct, grader wrong
    p1 = {
        **packet_base,
        "hidden": {**packet_base["hidden"], "regradedOutcome": "wrong"},
    }
    s1 = score_judgment(p1, {"mathJudgment": "correct", "formatCompliant": True})
    # Reviewer incorrect, grader correct
    p2 = {
        **packet_base,
        "hidden": {**packet_base["hidden"], "regradedOutcome": "correct"},
        "blind": {
            "problemStatement": "Solve x=2",
            "rawModelResponse": "ANSWER: 9",
        },
    }
    s2 = score_judgment(p2, {"mathJudgment": "incorrect", "formatCompliant": True})
    return {
        "reviewerCorrectGraderWrong": {
            "disagreement": s1.get("disagreementWithDeterministic"),
            "independentEqual": s1.get("independentEqual"),
            "independentComparable": s1.get("independentComparable"),
        },
        "reviewerIncorrectGraderCorrect": {
            "disagreement": s2.get("disagreementWithDeterministic"),
            "independentEqual": s2.get("independentEqual"),
            "independentComparable": s2.get("independentComparable"),
        },
        "symmetricDisagreementFlag": (
            s1.get("disagreementWithDeterministic") is True
            and s2.get("disagreementWithDeterministic") is True
        ),
    }


def partition_results(results: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    parse_failures = []
    disagreements = []
    agreements = []
    other = []
    for r in results:
        parsed_ok = bool((r.get("parsed") or {}).get("ok"))
        dclass = r.get("disagreementClass")
        score = r.get("score") or {}
        if not parsed_ok or dclass == "reviewer_unparseable":
            parse_failures.append(r)
        elif score.get("disagreementWithDeterministic") is True or dclass in {
            "disagree_exact_check_applied",
            "escalate_human_review",
            "possible_grader_false_negative",
            "possible_grader_false_positive",
        }:
            disagreements.append(r)
        elif dclass == "agree_with_deterministic" or score.get("disagreementWithDeterministic") is False:
            agreements.append(r)
        else:
            other.append(r)
    return {
        "parse_failures": parse_failures,
        "disagreements": disagreements,
        "agreements": agreements,
        "other": other,
    }


def adjudicate_report(report: dict[str, Any]) -> dict[str, Any]:
    results = list(report.get("results") or [])
    n = len(results)
    parts = partition_results(results)

    parse_analyses = [classify_parse_failure(r) for r in parts["parse_failures"]]
    disagreement_analyses = [adjudicate_disagreement(r) for r in parts["disagreements"]]

    by_family: Counter[str] = Counter()
    by_label: Counter[str] = Counter()
    by_dclass: Counter[str] = Counter()
    by_parse_kind: Counter[str] = Counter()
    exp_log = []
    for a in disagreement_analyses:
        by_family[str(a["family"])] += 1
        by_label[str(a["adjudicationLabel"])] += 1
        by_dclass[str(a["disagreementClass"])] += 1
        if a["family"] == "exponential_log_equations":
            exp_log.append(a)
    for p in parse_analyses:
        by_parse_kind[str(p["parseFailureKind"])] += 1

    confirmed_grader_support = sum(
        1
        for a in disagreement_analyses
        if a["adjudicationLabel"].startswith("exact_check_supports_grader")
        or a["adjudicationLabel"].startswith("exact_check_unequal")
    )
    possible_grader_issues = sum(
        1
        for a in disagreement_analyses
        if "possible_grader" in a["adjudicationLabel"]
    )
    unresolved = sum(1 for a in disagreement_analyses if a["needsHumanReview"])
    resolved_no_human = sum(1 for a in disagreement_analyses if not a["needsHumanReview"])

    # Reconcile to packet count
    n_agree = len(parts["agreements"])
    n_disagree = len(parts["disagreements"])
    n_parse = len(parts["parse_failures"])
    n_other = len(parts["other"])
    reconciled = n_agree + n_disagree + n_parse + n_other

    symmetry = verify_score_judgment_symmetry()

    summary = {
        "ok": reconciled == n,
        "adjudicationVersion": ADJUDICATION_VERSION,
        "graderVersion": GRADER_VERSION,
        "sourcePacketCount": n,
        "designPacketCount": DESIGN_PACKET_COUNT,
        "reconciliation": {
            "agreements": n_agree,
            "disagreements": n_disagree,
            "parseFailures": n_parse,
            "otherNonBinary": n_other,
            "sum": reconciled,
            "equalsPacketCount": reconciled == n,
        },
        "disagreementBreakdown": {
            "total": n_disagree,
            "byDisagreementClass": dict(by_dclass),
            "byFamily": dict(by_family),
            "byAdjudicationLabel": dict(by_label),
            "exactCheckSupportsGraderUnequal": confirmed_grader_support,
            "possibleGraderIssueCandidates": possible_grader_issues,
            "resolvedWithoutHuman": resolved_no_human,
            "needsHumanReview": unresolved,
        },
        "parseFailureBreakdown": {
            "total": n_parse,
            "byKind": dict(by_parse_kind),
        },
        "exponentialLogPriority": {
            "disagreementCount": len(exp_log),
            "needsHumanReview": sum(1 for a in exp_log if a["needsHumanReview"]),
            "labels": dict(Counter(a["adjudicationLabel"] for a in exp_log)),
        },
        "scoreJudgmentSymmetry": symmetry,
        "policy": [
            "Do not treat independentEqual=false alone as proof Gemma erred",
            "Do not treat numerical approximations as definitive proof",
            "Official grades are not modified by this adjudication",
            "Unresolved cases escalate to human review",
            "No Stage B / training / promotion from this report",
        ],
        "officialGradesModified": False,
        "lockedDataAccessed": False,
        "gpuWorkloadExecuted": False,
    }

    # Review queue: disagreements first (exp/log prioritized), then parse failures
    queue = sorted(
        disagreement_analyses,
        key=lambda a: (
            0 if a["family"] == "exponential_log_equations" else 1,
            0 if a["needsHumanReview"] else 1,
            str(a["family"]),
            str(a["itemId"]),
        ),
    )
    queue.extend(
        {
            "queueType": "parse_failure",
            **p,
            "needsHumanReview": True,
            "adjudicationLabel": f"parse_failure:{p['parseFailureKind']}",
        }
        for p in parse_analyses
    )

    return {
        "summary": summary,
        "reviewQueue": queue,
        "disagreementAnalyses": disagreement_analyses,
        "parseFailureAnalyses": parse_analyses,
        "exponentialLogDisagreements": exp_log,
    }


def write_adjudication_bundle(report_path: Path, out_dir: Path) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    report = load_audit_report(report_path)
    bundle = adjudicate_report(report)
    summary = bundle["summary"]
    summary["sourceReportPath"] = str(report_path.resolve())
    summary["outputDir"] = str(out_dir.resolve())

    (out_dir / "adjudication-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (out_dir / "adjudication-review-queue.jsonl").write_text(
        "\n".join(json.dumps(q, sort_keys=True) for q in bundle["reviewQueue"])
        + ("\n" if bundle["reviewQueue"] else ""),
        encoding="utf-8",
    )
    (out_dir / "adjudication-disagreements.json").write_text(
        json.dumps(bundle["disagreementAnalyses"], indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (out_dir / "adjudication-parse-failures.json").write_text(
        json.dumps(bundle["parseFailureAnalyses"], indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (out_dir / "adjudication-exp-log.json").write_text(
        json.dumps(bundle["exponentialLogDisagreements"], indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    # Human-readable markdown summary
    s = summary
    md = [
        f"# C1.8D audit adjudication ({ADJUDICATION_VERSION})",
        "",
        f"- Source packets: **{s['sourcePacketCount']}**",
        f"- Reconciliation: agree {s['reconciliation']['agreements']} + "
        f"disagree {s['reconciliation']['disagreements']} + "
        f"parseFail {s['reconciliation']['parseFailures']} + "
        f"other {s['reconciliation']['otherNonBinary']} "
        f"= **{s['reconciliation']['sum']}** "
        f"(ok={s['reconciliation']['equalsPacketCount']})",
        f"- Disagreements needing human review: **{s['disagreementBreakdown']['needsHumanReview']}**",
        f"- Exact-check supports grader (unequal): "
        f"**{s['disagreementBreakdown']['exactCheckSupportsGraderUnequal']}**",
        f"- Possible grader-issue candidates: "
        f"**{s['disagreementBreakdown']['possibleGraderIssueCandidates']}**",
        f"- Parse failures: **{s['parseFailureBreakdown']['total']}** "
        f"{s['parseFailureBreakdown']['byKind']}",
        f"- Exp/log disagreements: **{s['exponentialLogPriority']['disagreementCount']}**",
        f"- Score symmetry check: **{s['scoreJudgmentSymmetry']['symmetricDisagreementFlag']}**",
        f"- Official grades modified: **{s['officialGradesModified']}**",
        "",
        "## STOP",
        "",
        "Do not start Stage B, training, pilot, or promotion from this adjudication.",
        "Unresolved cases require human review. Do not change the official grader "
        "without a separately reviewed defect and versioned fix.",
        "",
    ]
    (out_dir / "ADJUDICATION_REPORT.md").write_text("\n".join(md), encoding="utf-8")
    return summary


def build_fixture_report() -> dict[str, Any]:
    """Minimal synthetic audit report covering disagreement directions + parse fails."""
    def row(
        *,
        pid: str,
        family: str,
        raw: str,
        expected: dict[str, Any],
        regraded: str,
        judgment: dict[str, Any] | None,
        parse_ok: bool,
        condition: str = "thinking_disabled_zero_shot",
        rationale: str = "test",
    ) -> dict[str, Any]:
        packet = {
            "packetId": pid,
            "itemId": f"item-{pid}",
            "conditionId": condition,
            "family": family,
            "sampleIndex": 0,
            "blind": {"problemStatement": f"Problem {pid}", "rawModelResponse": raw},
            "hidden": {"regradedOutcome": regraded, "expected": expected, "graderVersion": GRADER_VERSION},
        }
        if parse_ok and judgment is not None:
            scored = score_judgment(packet, judgment)
            dclass = classify_disagreement(scored, judgment)
            parsed = {"ok": True, "judgment": judgment}
        else:
            scored = {
                "disagreementWithDeterministic": None,
                "independentEqual": None,
                "independentComparable": False,
            }
            dclass = "reviewer_unparseable"
            parsed = {"ok": False, "reason": judgment.get("reason") if judgment else "no_json"}
            judgment = None
        return {
            "packetId": pid,
            "itemId": packet["itemId"],
            "conditionId": condition,
            "family": family,
            "sampleIndex": 0,
            "blindPacket": packet["blind"],
            "hidden": packet["hidden"],
            "judgment": judgment,
            "parsed": parsed,
            "score": scored,
            "disagreementClass": dclass,
            "response": {"ok": parse_ok, "rawContent": raw if not parse_ok else json.dumps(judgment), "error": None},
        }

    results = [
        # Agree
        row(
            pid="agree1",
            family="linear_equations",
            raw="ANSWER: 2",
            expected={"kind": "roots", "values": ["2"]},
            regraded="correct",
            judgment={"mathJudgment": "correct", "formatCompliant": True, "briefRationale": "ok"},
            parse_ok=True,
        ),
        # Reviewer correct / grader wrong + unequal (exact check)
        row(
            pid="dis-uneq",
            family="exponential_log_equations",
            raw="ANSWER: 99",
            expected={"kind": "roots", "values": ["2"]},
            regraded="wrong",
            judgment={
                "mathJudgment": "correct",
                "formatCompliant": True,
                "briefRationale": "The reasoning looks correct.",
            },
            parse_ok=True,
        ),
        # Reviewer incorrect / grader correct
        row(
            pid="dis-rev-wrong",
            family="quadratic_equations",
            raw="ANSWER: 2",
            expected={"kind": "roots", "values": ["2"]},
            regraded="correct",
            judgment={"mathJudgment": "incorrect", "formatCompliant": True, "briefRationale": "wrong"},
            parse_ok=True,
        ),
        # Escalation: no extractable answer
        row(
            pid="dis-esc",
            family="exponential_log_equations",
            raw="I think the answer involves log but...",
            expected={"kind": "roots", "values": ["2"]},
            regraded="wrong",
            judgment={"mathJudgment": "correct", "formatCompliant": False, "briefRationale": "domain ok"},
            parse_ok=True,
        ),
        # Parse failures
        row(
            pid="parse-empty",
            family="linear_equations",
            raw="",
            expected={"kind": "roots", "values": ["1"]},
            regraded="wrong",
            judgment={"reason": "empty_response"},
            parse_ok=False,
        ),
        row(
            pid="parse-malformed",
            family="linear_equations",
            raw='{"mathJudgment": "correct", ',
            expected={"kind": "roots", "values": ["1"]},
            regraded="wrong",
            judgment={"reason": "no_json"},
            parse_ok=False,
        ),
    ]
    # Force parse failure rows to have empty/bad rawContent
    results[4]["response"] = {"ok": False, "rawContent": "", "error": None}
    results[4]["parsed"] = {"ok": False, "reason": "empty_response"}
    results[5]["response"] = {
        "ok": True,
        "rawContent": '{"mathJudgment": "correct", ',
        "error": None,
    }
    results[5]["parsed"] = {"ok": False, "reason": "no_json"}
    results[5]["disagreementClass"] = "reviewer_unparseable"
    results[5]["judgment"] = None

    return {
        "ok": True,
        "packetCount": len(results),
        "parseOkCount": sum(1 for r in results if (r.get("parsed") or {}).get("ok")),
        "disagreementCount": sum(
            1 for r in results if (r.get("score") or {}).get("disagreementWithDeterministic") is True
        ),
        "results": results,
        "fixture": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        type=Path,
        help="Path to gemma-full-audit-report.json (omit with --fixture for CPU demo).",
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--fixture",
        action="store_true",
        help="Run against a built-in synthetic fixture (no VM file required).",
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    if args.fixture or args.report is None:
        report = build_fixture_report()
        (args.out / "fixture-source-report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        report_path = args.out / "fixture-source-report.json"
    else:
        report_path = args.report
        if not report_path.is_file():
            raise SystemExit(f"report missing: {report_path}")

    summary = write_adjudication_bundle(report_path, args.out)
    print(
        json.dumps(
            {
                "ok": summary["ok"],
                "adjudicationVersion": summary["adjudicationVersion"],
                "sourcePacketCount": summary["sourcePacketCount"],
                "reconciliation": summary["reconciliation"],
                "disagreementBreakdown": {
                    "total": summary["disagreementBreakdown"]["total"],
                    "needsHumanReview": summary["disagreementBreakdown"]["needsHumanReview"],
                    "byFamily": summary["disagreementBreakdown"]["byFamily"],
                },
                "parseFailureBreakdown": summary["parseFailureBreakdown"],
                "out": str(args.out / "adjudication-summary.json"),
            },
            indent=2,
        ),
    )
    if not summary["ok"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
