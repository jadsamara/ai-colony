#!/usr/bin/env python3
"""Runtime / GPU-hour projections from measured C1.8D.1 runs.

Projections require measured wall-clock and token stats. They must not invent
throughput. Thinking-mode uncertainty is stated explicitly.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

PROJECTION_VERSION = "c18d1-projections-v2"

# Operator-measured HF thinking-enabled backend benchmark (8 stratified items).
# Lower-bound flag: 2048 token cap; Stage thinking policy allows 8192.
HF_THINKING_PILOT_MEASURED = {
    "backend": "huggingface-batched",
    "conditionId": "thinking_enabled_zero_shot",
    "itemCount": 8,
    "samplesPerProblem": 1,
    "sampleSize": 8,
    "timing": {"wallClockMs": 8 * 12_600, "evalMs": 8 * 12_600},
    "decoding": {"enableThinking": True, "maxNewTokens": 2048},
    "tokensPerSecondApprox": 69,
    "meanGeneratedTokensApprox": 860,
    "meanSecondsPerSampleApprox": 12.6,
    "maxNewTokensMeasured": 2048,
    "stageThinkingCapTokens": 8192,
    "correct": 7,
    "truncated": 0,
    "evaluationImplementationVersion": "c18d1-batched-eval-v5",
}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def project_from_measured(
    measured: dict[str, Any],
    *,
    target_item_counts: dict[str, int],
    samples_per_problem: dict[str, int] | None = None,
    lower_bound_flag: bool = False,
) -> dict[str, Any]:
    """Scale measured per-sample latency to larger evaluation sizes."""
    timing = measured.get("timing") or {}
    wall_ms = timing.get("wallClockMs") or timing.get("evalMs")
    sample_size = measured.get("sampleSize") or measured.get("accounting", {}).get("sampleSize")
    if not sample_size:
        item_count = measured.get("itemCount")
        spp = measured.get("samplesPerProblem") or 1
        if item_count:
            sample_size = int(item_count) * int(spp)
    mean_s = measured.get("meanSecondsPerSampleApprox")
    if (not wall_ms) and mean_s and sample_size:
        wall_ms = float(mean_s) * 1000.0 * float(sample_size)
    if not wall_ms or not sample_size:
        return {
            "ok": False,
            "projectionVersion": PROJECTION_VERSION,
            "reason": "missing_measured_timing_or_sample_size",
            "note": "Do not invent throughput; re-run with measured timing fields.",
        }

    ms_per_sample = float(wall_ms) / float(sample_size)
    enable_thinking = bool((measured.get("decoding") or {}).get("enableThinking"))
    low_mult, high_mult = (0.85, 1.25) if not enable_thinking else (0.7, 2.5)

    spp_map = samples_per_problem or {}
    targets = []
    for name, items in target_item_counts.items():
        spp = int(spp_map.get(name, measured.get("samplesPerProblem") or 1))
        samples = int(items) * spp
        point_ms = ms_per_sample * samples
        targets.append(
            {
                "name": name,
                "itemCount": int(items),
                "samplesPerProblem": spp,
                "sampleSize": samples,
                "pointEstimateGpuHours": point_ms / 3_600_000.0,
                "lowGpuHours": (point_ms * low_mult) / 3_600_000.0,
                "highGpuHours": (point_ms * high_mult) / 3_600_000.0,
                "pointEstimateWallClockHours": point_ms / 3_600_000.0,
            },
        )

    caveats = [
        "Scaled from measured wall-clock only; does not invent tokens/s.",
        "Thinking-mode high band (×2.5) reflects long-tail generation length.",
        "Batch size, GPU, and backend must match the measured run for validity.",
        "Model load time may be amortized differently on long jobs.",
    ]
    if lower_bound_flag or enable_thinking:
        caveats.extend(
            [
                "FLAGGED AS LOWER BOUND: measured under a 2048-token cap; "
                "thinking-enabled Stage policy allows up to 8192 new tokens.",
                "Hard families with longer thinking may substantially exceed this estimate.",
            ],
        )

    return {
        "ok": True,
        "projectionVersion": PROJECTION_VERSION,
        "flag": (
            "lower_bound_pending_longer_thinking_and_8192_cap"
            if (lower_bound_flag or enable_thinking)
            else None
        ),
        "basis": {
            "measuredWallClockMs": wall_ms,
            "measuredSampleSize": sample_size,
            "msPerSample": ms_per_sample,
            "enableThinking": enable_thinking,
            "maxNewTokensMeasured": measured.get("maxNewTokensMeasured")
            or (measured.get("decoding") or {}).get("maxNewTokens"),
            "stageThinkingCapTokens": measured.get("stageThinkingCapTokens", 8192),
            "tokensPerSecondApprox": measured.get("tokensPerSecondApprox"),
            "meanGeneratedTokensApprox": measured.get("meanGeneratedTokensApprox"),
            "uncertaintyMultipliers": {"low": low_mult, "high": high_mult},
            "sourceConditionId": measured.get("conditionId"),
            "sourceBackend": measured.get("backend"),
            "sourceEvalVersion": measured.get("evaluationImplementationVersion") or measured.get("specVersion"),
        },
        "targets": targets,
        "caveats": caveats,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--measured-report", type=Path, default=None)
    parser.add_argument("--from-hf-thinking-pilot", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stage-b-items", type=int, default=500)
    parser.add_argument("--stage-c-items", type=int, default=1300)
    args = parser.parse_args()
    if args.from_hf_thinking_pilot:
        measured = dict(HF_THINKING_PILOT_MEASURED)
        lower = True
    elif args.measured_report:
        measured = json.loads(args.measured_report.read_text(encoding="utf-8"))
        # Prefer nested HF run timing when given a backend-benchmark report.
        if "runs" in measured and "huggingface" in measured["runs"]:
            hf = measured["runs"]["huggingface"]
            measured = {
                **measured,
                "timing": hf.get("timing"),
                "sampleSize": (hf.get("accounting") or {}).get("sampleSize"),
                "backend": hf.get("backend"),
                "decoding": measured.get("decoding"),
            }
        lower = bool((measured.get("decoding") or {}).get("enableThinking"))
    else:
        raise SystemExit("Provide --measured-report or --from-hf-thinking-pilot")

    spp_thinking = 3 if (measured.get("decoding") or {}).get("enableThinking") else 1
    report = project_from_measured(
        measured,
        target_item_counts={
            "stage_b_dev": args.stage_b_items,
            "stage_b_dev_pass_at_3": args.stage_b_items,
            "stage_c_locked_scale": args.stage_c_items,
        },
        samples_per_problem={
            "stage_b_dev": int(measured.get("samplesPerProblem") or 1),
            "stage_b_dev_pass_at_3": spp_thinking,
            "stage_c_locked_scale": int(measured.get("samplesPerProblem") or 1),
        },
        lower_bound_flag=lower,
    )
    _write_json(args.output, report)
    print(json.dumps({"ok": report.get("ok"), "flag": report.get("flag"), "output": str(args.output)}, indent=2))


if __name__ == "__main__":
    main()
