#!/usr/bin/env python3
"""Re-evaluate existing v1 Phase 0 adapters under matched two-mode settings.

Does not retrain. Does not unlock autonomous training.
Quantifies truncated / no-final-answer rates for base and adapter.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PHASE0 = Path(__file__).resolve().parent
THRESHOLDS = json.loads((PHASE0 / "thresholds-v2.1.json").read_text(encoding="utf-8"))
MODES = THRESHOLDS["evaluation"]["modes"]


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run_eval(
    *,
    python: str,
    model_id: str,
    dataset: Path,
    out_dir: Path,
    adapter_path: str | None,
    mode: dict[str, Any],
    device: str,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "modelId": model_id,
        "datasetPath": str(dataset),
        "outputDir": str(out_dir),
        "adapterPath": adapter_path,
        "device": device,
        "thinkingMode": mode["id"],
        "enableThinking": mode["enableThinking"],
        "maxNewTokens": mode["maxNewTokens"],
        "maxBaseInvalidRate": THRESHOLDS["evaluation"]["maxBaseInvalidRate"],
    }
    _write_json(out_dir / "job.json", job)
    subprocess.run([python, str(ROOT / "peft_lora_eval.py"), "--job", str(out_dir / "job.json")], check=True)
    return json.loads((out_dir / "eval-result.json").read_text(encoding="utf-8"))


def _mode_report(base: dict[str, Any], adapter: dict[str, Any], mode: dict[str, Any]) -> dict[str, Any]:
    base_invalid_ok = bool(base.get("evaluationValid"))
    return {
        "thinkingMode": mode["id"],
        "maxNewTokens": mode["maxNewTokens"],
        "enableThinking": mode["enableThinking"],
        "base": {
            "exactMatch": base.get("exactMatch"),
            "invalidRate": base.get("invalidRate"),
            "truncatedCount": base.get("truncatedCount"),
            "noFinalAnswerCount": base.get("noFinalAnswerCount"),
            "correct": base.get("correct"),
            "wrong": base.get("wrong"),
            "invalid": base.get("invalid"),
            "evaluationValid": base_invalid_ok,
            "templateFingerprint": base.get("templateFingerprint"),
        },
        "adapter": {
            "exactMatch": adapter.get("exactMatch"),
            "invalidRate": adapter.get("invalidRate"),
            "truncatedCount": adapter.get("truncatedCount"),
            "noFinalAnswerCount": adapter.get("noFinalAnswerCount"),
            "correct": adapter.get("correct"),
            "wrong": adapter.get("wrong"),
            "invalid": adapter.get("invalid"),
            "adapterLoaded": adapter.get("adapterLoaded"),
            "templateFingerprint": adapter.get("templateFingerprint"),
        },
        "improvement": float(adapter.get("exactMatch") or 0) - float(base.get("exactMatch") or 0),
        "fairComparison": base_invalid_ok,
        "note": (
            None
            if base_invalid_ok
            else "Base invalidRate exceeded 5%; this mode is an invalid evaluation, not a pass."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model-id", default=THRESHOLDS["gpuGate"]["modelId"])
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--memorization-adapter", type=Path, required=True)
    parser.add_argument("--generalization-adapter", type=Path, required=True)
    args = parser.parse_args()

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "specVersion": "c18d-phase0-reeval-v1-report",
        "status": "diagnostic",
        "autonomousTrainingUnlocked": False,
        "thresholdsVersion": THRESHOLDS["specVersion"],
        "gatingMode": THRESHOLDS["evaluation"]["gatingMode"],
        "modelId": args.model_id,
        "controls": {},
        "auditConclusion": [],
    }

    for control_id, dataset, adapter in [
        ("memorization", PHASE0 / "memorization.jsonl", args.memorization_adapter),
        ("generalization_v1", PHASE0 / "generalization_heldout.jsonl", args.generalization_adapter),
    ]:
        mode_rows = []
        for mode in MODES:
            base = _run_eval(
                python=args.python,
                model_id=args.model_id,
                dataset=dataset,
                out_dir=out / control_id / mode["id"] / "base",
                adapter_path=None,
                mode=mode,
                device=args.device,
            )
            adapter_eval = _run_eval(
                python=args.python,
                model_id=args.model_id,
                dataset=dataset,
                out_dir=out / control_id / mode["id"] / "adapter",
                adapter_path=str(adapter.resolve()),
                mode=mode,
                device=args.device,
            )
            mode_rows.append(_mode_report(base, adapter_eval, mode))
        report["controls"][control_id] = mode_rows

    # Honest audit notes (no invented GPU percentages beyond what this run measured).
    for control_id, rows in report["controls"].items():
        for row in rows:
            base = row["base"]
            report["auditConclusion"].append(
                {
                    "controlId": control_id,
                    "thinkingMode": row["thinkingMode"],
                    "baseTruncatedCount": base["truncatedCount"],
                    "baseNoFinalAnswerCount": base["noFinalAnswerCount"],
                    "baseInvalidRate": base["invalidRate"],
                    "adapterTruncatedCount": row["adapter"]["truncatedCount"],
                    "adapterNoFinalAnswerCount": row["adapter"]["noFinalAnswerCount"],
                    "fairComparison": row["fairComparison"],
                    "baseExactMatch": base["exactMatch"],
                    "adapterExactMatch": row["adapter"]["exactMatch"],
                },
            )
            if row["fairComparison"] and float(base["exactMatch"] or 0) >= 0.9:
                report["auditConclusion"].append(
                    {
                        "controlId": control_id,
                        "thinkingMode": row["thinkingMode"],
                        "warning": (
                            "Fairly evaluated base already performs well on this v1 control; "
                            "adapter lift is not strong evidence of generalization."
                        ),
                    },
                )

    _write_json(out / "reeval-v1-report.json", report)
    print(json.dumps({"report": str(out / "reeval-v1-report.json"), "autonomousTrainingUnlocked": False}, indent=2))


if __name__ == "__main__":
    main()
