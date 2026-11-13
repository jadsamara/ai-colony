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

PROJECTION_VERSION = "c18d1-projections-v1"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def project_from_measured(
    measured: dict[str, Any],
    *,
    target_item_counts: dict[str, int],
    samples_per_problem: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Scale measured per-sample latency to larger evaluation sizes.

    ``measured`` must include timing.wallClockMs or timing.evalMs and sampleSize.
    """
    timing = measured.get("timing") or {}
    wall_ms = timing.get("wallClockMs") or timing.get("evalMs")
    sample_size = measured.get("sampleSize") or measured.get("accounting", {}).get("sampleSize")
    if not sample_size:
        # Derive from itemCount × samplesPerProblem when present
        item_count = measured.get("itemCount")
        spp = measured.get("samplesPerProblem") or 1
        if item_count:
            sample_size = int(item_count) * int(spp)
    if not wall_ms or not sample_size:
        return {
            "ok": False,
            "projectionVersion": PROJECTION_VERSION,
            "reason": "missing_measured_timing_or_sample_size",
            "note": "Do not invent throughput; re-run with measured timing fields.",
        }

    ms_per_sample = float(wall_ms) / float(sample_size)
    # Uncertainty bands for thinking-mode: longer generations dominate variance.
    enable_thinking = bool((measured.get("decoding") or {}).get("enableThinking"))
    # Conservative multipliers when thinking enabled (generation length variance).
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

    return {
        "ok": True,
        "projectionVersion": PROJECTION_VERSION,
        "basis": {
            "measuredWallClockMs": wall_ms,
            "measuredSampleSize": sample_size,
            "msPerSample": ms_per_sample,
            "enableThinking": enable_thinking,
            "uncertaintyMultipliers": {"low": low_mult, "high": high_mult},
            "sourceConditionId": measured.get("conditionId"),
            "sourceBackend": measured.get("backend"),
            "sourceEvalVersion": measured.get("evaluationImplementationVersion") or measured.get("specVersion"),
        },
        "targets": targets,
        "caveats": [
            "Scaled from measured wall-clock only; does not invent tokens/s.",
            "Thinking-mode high band (×2.5) reflects long-tail generation length.",
            "Batch size, GPU, and backend must match the measured run for validity.",
            "Model load time may be amortized differently on long jobs.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--measured-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stage-b-items", type=int, default=500)
    parser.add_argument("--stage-c-items", type=int, default=1300)
    args = parser.parse_args()
    measured = json.loads(args.measured_report.read_text(encoding="utf-8"))
    spp = int(measured.get("samplesPerProblem") or 1)
    report = project_from_measured(
        measured,
        target_item_counts={"stage_b_dev": args.stage_b_items, "stage_c_locked_scale": args.stage_c_items},
        samples_per_problem={"stage_b_dev": spp, "stage_c_locked_scale": spp},
    )
    _write_json(args.output, report)
    print(json.dumps({"ok": report.get("ok"), "output": str(args.output)}, indent=2))


if __name__ == "__main__":
    main()
