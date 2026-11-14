#!/usr/bin/env python3
"""Run 12-case Gemma smoke validation against a local vLLM OpenAI server.

Blind to expected answers. Scores judgments against hidden independent labels.
Never updates official grades. Records latency, parse success, and runtime estimate.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from blind_llm_audit import BLIND_SYSTEM_PROMPT
from gemma_smoke_validation import build_smoke_cases, write_smoke_bundle
from reviewer_gemma3 import PINNED_GEMMA3_27B_IT, PROPOSED_REVIEWER, estimate_runtime

RUNNER_VERSION = "c18d1-gemma-smoke-runner-v1"
JSON_BLOCK = re.compile(r"\{[^{}]*\}", re.DOTALL)


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
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
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


def parse_reviewer_json(text: str | None) -> dict[str, Any]:
    if not text:
        return {"ok": False, "reason": "empty_response"}
    text = text.strip()
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return {"ok": True, "judgment": obj}
    except json.JSONDecodeError:
        pass
    # fenced or trailing prose
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        try:
            return {"ok": True, "judgment": json.loads(fence.group(1))}
        except json.JSONDecodeError:
            pass
    m = JSON_BLOCK.search(text)
    if m:
        try:
            return {"ok": True, "judgment": json.loads(m.group(0))}
        except json.JSONDecodeError:
            return {"ok": False, "reason": "json_block_invalid", "raw": text[:500]}
    return {"ok": False, "reason": "no_json", "raw": text[:500]}


def score_smoke_case(case: dict[str, Any], judgment: dict[str, Any] | None) -> dict[str, Any]:
    truth = case["hidden"]["independentTruth"]
    math_j = str((judgment or {}).get("mathJudgment") or "")
    if truth == "correct":
        agree = math_j == "correct"
        expected_bucket = "correct"
    else:
        agree = math_j in {"incorrect", "insufficient_response", "uncertain"}
        # Prefer incorrect/insufficient; uncertain counts as soft agree for smoke bar
        expected_bucket = "incorrect_or_insufficient"
    return {
        "agreeWithIndependentTruth": agree,
        "expectedBucket": expected_bucket,
        "reviewerMathJudgment": math_j or None,
        "reviewerFormatCompliant": (judgment or {}).get("formatCompliant"),
        "briefRationale": (judgment or {}).get("briefRationale"),
    }


def wait_for_server(base_url: str, *, timeout_s: float = 600.0) -> dict[str, Any]:
    url = base_url.rstrip("/") + "/v1/models"
    t0 = time.time()
    last_err = None
    while time.time() - t0 < timeout_s:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            return {
                "ok": True,
                "waitMs": int((time.time() - t0) * 1000),
                "models": payload,
            }
        except Exception as exc:  # noqa: BLE001
            last_err = f"{type(exc).__name__}: {exc}"
            time.sleep(2)
    return {"ok": False, "waitMs": int((time.time() - t0) * 1000), "error": last_err}


def run_smoke(
    *,
    base_url: str,
    out_dir: Path,
    timeout_s: float = 120.0,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    write_smoke_bundle(out_dir / "fixtures")
    cases = build_smoke_cases()
    pin = PINNED_GEMMA3_27B_IT
    sampling = PROPOSED_REVIEWER["sampling"]
    model = pin["modelId"]

    ready = wait_for_server(base_url)
    if not ready.get("ok"):
        report = {
            "ok": False,
            "runnerVersion": RUNNER_VERSION,
            "error": "server_not_ready",
            "ready": ready,
            "gpuWorkloadAuthorized": True,
            "fullAuditAuthorized": False,
        }
        (out_dir / "gemma-smoke-report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return report

    results: list[dict[str, Any]] = []
    latencies: list[int] = []
    parse_ok = 0
    agree_n = 0
    for case in cases:
        user = (
            f"Problem:\n{case['blind']['problemStatement']}\n\n"
            f"Model response:\n{case['blind']['rawModelResponse']}\n\n"
            "Return JSON with mathJudgment, formatCompliant, briefRationale."
        )
        # Blind: do not send expected / truth / grades
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
        if parsed.get("ok"):
            parse_ok += 1
        scored = score_smoke_case(case, parsed.get("judgment") if parsed.get("ok") else None)
        if scored["agreeWithIndependentTruth"]:
            agree_n += 1
        if resp.get("latencyMs") is not None:
            latencies.append(int(resp["latencyMs"]))
        results.append(
            {
                "smokeId": case["smokeId"],
                "label": case["label"],
                "blindPacket": case["blind"],
                "response": resp,
                "parsed": parsed,
                "score": scored,
                # hidden kept in report for operator audit trail; never sent to model
                "hiddenTruth": case["hidden"]["independentTruth"],
            },
        )

    mean_lat = (sum(latencies) / len(latencies)) if latencies else None
    # Extrapolate full audit from measured mean latency (conservative serial; batched faster)
    n_full = 307
    est_min_serial = ((mean_lat or 2500) / 1000.0 * n_full) / 60.0
    runtime = estimate_runtime(n_full)
    runtime["measuredMeanLatencyMs"] = mean_lat
    runtime["estimatedFullAuditMinutesFromSmokeSerial"] = round(est_min_serial, 1)
    runtime["estimatedFullAuditGpuHoursFromSmokeSerial"] = round(est_min_serial / 60.0, 2)

    passed = agree_n >= 10 and parse_ok >= 10
    report = {
        "ok": passed,
        "runnerVersion": RUNNER_VERSION,
        "passCriteria": "≥10/12 agree with independent truth AND ≥10/12 parseable JSON",
        "agreeCount": agree_n,
        "parseOkCount": parse_ok,
        "caseCount": len(cases),
        "meanLatencyMs": mean_lat,
        "maxLatencyMs": max(latencies) if latencies else None,
        "minLatencyMs": min(latencies) if latencies else None,
        "serverReady": ready,
        "reviewer": {
            "modelId": pin["modelId"],
            "modelRevision": pin["modelRevision"],
            "baseUrl": base_url,
            "sampling": sampling,
            "systemPrompt": BLIND_SYSTEM_PROMPT,
        },
        "runtimeEstimate": runtime,
        "results": results,
        "officialGradesModified": False,
        "fullAuditAuthorized": False,
        "fullAuditExecuted": False,
        "note": (
            "Smoke only. Do not treat Gemma judgments as ground truth. "
            "Do not run the 307-case audit without separate approval."
        ),
    }
    (out_dir / "gemma-smoke-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (out_dir / "gemma-smoke-judgments.jsonl").write_text(
        "\n".join(json.dumps(r, sort_keys=True) for r in results) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8001")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timeout-s", type=float, default=120.0)
    args = parser.parse_args()
    report = run_smoke(base_url=args.base_url, out_dir=args.out, timeout_s=args.timeout_s)
    print(
        json.dumps(
            {
                "ok": report.get("ok"),
                "agreeCount": report.get("agreeCount"),
                "parseOkCount": report.get("parseOkCount"),
                "meanLatencyMs": report.get("meanLatencyMs"),
                "out": str(args.out / "gemma-smoke-report.json"),
            },
            indent=2,
        ),
    )
    if not report.get("ok"):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
