#!/usr/bin/env python3
"""Full 307-case Gemma blind LLM audit runner (gated).

Reads prepare-step blind packets, calls local vLLM, scores judgments, and
persists item-level results + disagreement classifications + provenance.

Does **not** launch by default. Requires C18D1_LLM_AUDIT_CONFIRM=1.
Never updates official grades. Gemma is never ground truth.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

from blind_llm_audit import (
    AUDIT_SPEC_VERSION,
    BLIND_SYSTEM_PROMPT,
    SMOKE_OBSERVED_METRICS,
    assert_blind_packet,
    estimate_runtime_from_smoke,
    reviewer_user_message,
    score_judgment,
)
from gemma_smoke_runner import parse_reviewer_json, wait_for_server
from reviewer_gemma3 import PINNED_GEMMA3_27B_IT, PROPOSED_REVIEWER

RUNNER_VERSION = "c18d1-gemma-full-audit-runner-v1"


def _chat_completion(
    *,
    base_url: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
    timeout_s: float,
) -> dict[str, Any]:
    import urllib.request

    url = base_url.rstrip("/") + "/v1/chat/completions"
    body = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    # Blindness: body must not include expected / grades
    blob = json.dumps(body)
    for needle in ("expected", "regradedOutcome", "originalOutcome", "independentTruth"):
        if f'"{needle}"' in blob:
            raise RuntimeError(f"refusing request that embeds {needle}")
    req = urllib.request.Request(
        url,
        data=blob.encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        latency_ms = int((time.time() - t0) * 1000)
        content = payload["choices"][0]["message"]["content"]
        return {
            "ok": True,
            "latencyMs": latency_ms,
            "rawContent": content,
            "usage": payload.get("usage"),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "latencyMs": int((time.time() - t0) * 1000),
            "rawContent": None,
            "usage": None,
            "error": f"{type(exc).__name__}: {exc}",
        }


def classify_disagreement(scored: dict[str, Any], judgment: dict[str, Any] | None) -> str:
    """Item-level disagreement class for provenance."""
    if not judgment:
        return "reviewer_unparseable"
    if scored.get("disagreementWithDeterministic") is False:
        return "agree_with_deterministic"
    if scored.get("disagreementWithDeterministic") is None:
        return "non_binary_or_uncertain"
    if scored.get("graderFalseNegativeCandidate"):
        return "possible_grader_false_negative"
    if scored.get("graderFalsePositiveCandidate"):
        return "possible_grader_false_positive"
    if scored.get("escalation") == "human_review":
        return "escalate_human_review"
    return "disagree_exact_check_applied"


def load_packets(path: Path) -> list[dict[str, Any]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def run_full_audit(
    *,
    packets_path: Path,
    out_dir: Path,
    base_url: str,
    timeout_s: float = 180.0,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    packets = load_packets(packets_path)
    pin = PINNED_GEMMA3_27B_IT
    sampling = PROPOSED_REVIEWER["sampling"]
    model = pin["modelId"]

    # Blindness preflight
    blind_issues = []
    for p in packets:
        issues = assert_blind_packet(p)
        if issues:
            blind_issues.append({"packetId": p.get("packetId"), "issues": issues})
    if blind_issues:
        report = {
            "ok": False,
            "error": "blindness_preflight_failed",
            "blindIssues": blind_issues[:32],
            "runnerVersion": RUNNER_VERSION,
            "fullAuditExecuted": False,
        }
        (out_dir / "gemma-full-audit-report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return report

    ready = wait_for_server(base_url, timeout_s=120.0)
    if not ready.get("ok"):
        report = {
            "ok": False,
            "error": "server_not_ready",
            "ready": ready,
            "runnerVersion": RUNNER_VERSION,
            "fullAuditExecuted": False,
        }
        (out_dir / "gemma-full-audit-report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return report

    results: list[dict[str, Any]] = []
    latencies: list[int] = []
    parse_ok = 0
    disagree_n = 0
    for packet in packets:
        user = reviewer_user_message(packet)
        # Confirm payload blindness again
        assert "regradedOutcome" not in user
        resp = _chat_completion(
            base_url=base_url,
            model=model,
            system=BLIND_SYSTEM_PROMPT,
            user=user,
            max_tokens=int(sampling["maxTokens"]),
            temperature=float(sampling["temperature"]),
            timeout_s=timeout_s,
        )
        parsed = parse_reviewer_json(resp.get("rawContent"))
        judgment = parsed.get("judgment") if parsed.get("ok") else None
        if parsed.get("ok"):
            parse_ok += 1
        scored = score_judgment(packet, judgment or {})
        dclass = classify_disagreement(scored, judgment)
        if scored.get("disagreementWithDeterministic") is True:
            disagree_n += 1
        if resp.get("latencyMs") is not None:
            latencies.append(int(resp["latencyMs"]))
        results.append(
            {
                "packetId": packet["packetId"],
                "itemId": packet["itemId"],
                "conditionId": packet["conditionId"],
                "family": packet["family"],
                "sampleIndex": packet.get("sampleIndex"),
                "correctSample": packet.get("correctSample"),
                "highRiskTransition": packet.get("highRiskTransition"),
                "blindPacket": packet["blind"],
                "response": resp,
                "parsed": parsed,
                "judgment": judgment,
                "score": scored,
                "disagreementClass": dclass,
                # hidden retained for operator adjudication trail only — never sent
                "hidden": packet.get("hidden"),
            },
        )

    mean_lat = (sum(latencies) / len(latencies)) if latencies else None
    runtime = estimate_runtime_from_smoke(len(packets))
    runtime["measuredMeanLatencyMs"] = mean_lat

    report = {
        "ok": True,
        "runnerVersion": RUNNER_VERSION,
        "auditSpecVersion": AUDIT_SPEC_VERSION,
        "packetCount": len(packets),
        "parseOkCount": parse_ok,
        "disagreementCount": disagree_n,
        "meanLatencyMs": mean_lat,
        "serverReady": ready,
        "reviewer": {
            "modelId": pin["modelId"],
            "modelRevision": pin["modelRevision"],
            "baseUrl": base_url,
            "sampling": sampling,
            "systemPrompt": BLIND_SYSTEM_PROMPT,
        },
        "smokeObservedPrior": SMOKE_OBSERVED_METRICS,
        "runtimeEstimate": runtime,
        "provenance": {
            "packetsPath": str(packets_path.resolve()),
            "pinnedRevision": pin["modelRevision"],
            "officialGradesModified": False,
            "lockedDataAccessed": False,
            "weightsRedownloaded": False,
        },
        "results": results,
        "fullAuditExecuted": True,
        "fullAuditAuthorized": True,
        "note": (
            "Gemma judgments are not ground truth. Adjudicate disagreements with "
            "SymPy/independent_check; escalate unresolved to human review. "
            "Does not authorize pilot / Stage B / training / promotion."
        ),
    }
    (out_dir / "gemma-full-audit-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (out_dir / "gemma-full-audit-judgments.jsonl").write_text(
        "\n".join(json.dumps(r, sort_keys=True) for r in results) + "\n",
        encoding="utf-8",
    )
    # Compact disagreement index for review
    disagreements = [
        {
            "packetId": r["packetId"],
            "itemId": r["itemId"],
            "conditionId": r["conditionId"],
            "disagreementClass": r["disagreementClass"],
            "score": r["score"],
            "judgment": r.get("judgment"),
        }
        for r in results
        if r["disagreementClass"]
        not in {"agree_with_deterministic"}
    ]
    (out_dir / "gemma-full-audit-disagreements.json").write_text(
        json.dumps(
            {
                "count": len(disagreements),
                "items": disagreements,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packets", type=Path, required=True, help="blind-packets.jsonl")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8001")
    parser.add_argument("--timeout-s", type=float, default=180.0)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually call the local Gemma server (requires C18D1_LLM_AUDIT_CONFIRM=1).",
    )
    args = parser.parse_args()

    if not args.execute:
        runtime = estimate_runtime_from_smoke()
        print(
            json.dumps(
                {
                    "ok": True,
                    "mode": "dry_run",
                    "runnerVersion": RUNNER_VERSION,
                    "runtimeEstimate": runtime,
                    "note": "Pass --execute with C18D1_LLM_AUDIT_CONFIRM=1 to run.",
                },
                indent=2,
            ),
        )
        return

    if os.environ.get("C18D1_LLM_AUDIT_CONFIRM") != "1":
        raise SystemExit(
            "Refusing full audit execute without C18D1_LLM_AUDIT_CONFIRM=1",
        )

    report = run_full_audit(
        packets_path=args.packets,
        out_dir=args.out,
        base_url=args.base_url,
        timeout_s=args.timeout_s,
    )
    print(
        json.dumps(
            {
                "ok": report.get("ok"),
                "packetCount": report.get("packetCount"),
                "parseOkCount": report.get("parseOkCount"),
                "disagreementCount": report.get("disagreementCount"),
                "out": str(args.out / "gemma-full-audit-report.json"),
            },
            indent=2,
        ),
    )
    if not report.get("ok"):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
