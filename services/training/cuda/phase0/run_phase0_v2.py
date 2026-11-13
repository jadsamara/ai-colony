#!/usr/bin/env python3
"""C1.8D Phase 0 corrected controls (thresholds v2).

Trains memorization + hidden-rule generalization, evaluates base and adapter
under both thinking modes with invalid-output accounting.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PHASE0 = Path(__file__).resolve().parent
THRESHOLDS = json.loads((PHASE0 / "thresholds-v2.json").read_text(encoding="utf-8"))
MODES = THRESHOLDS["evaluation"]["modes"]


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def _train(
    *,
    python: str,
    model_id: str,
    dataset: Path,
    out_dir: Path,
    device: str,
    steps: int,
    seed: int,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "backend": "peft-lora",
        "allowGpuTraining": True,
        "phase": "c18d-phase0-v2",
        "modelId": model_id,
        "datasetPath": str(dataset),
        "outputDir": str(out_dir),
        "seed": seed,
        "steps": steps,
        "learningRate": 2e-4,
        "loraRank": 8,
        "loraAlpha": 16,
        "batchSize": 1,
        "gradAccum": 4,
        "maxSeqLen": 192,
        "device": device,
        "downloadWeights": True,
    }
    _write_json(out_dir / "job.json", job)
    _run([python, str(ROOT / "peft_lora_train.py"), "--job", str(out_dir / "job.json")])
    return json.loads((out_dir / "result.json").read_text(encoding="utf-8"))


def _eval(
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
    _run([python, str(ROOT / "peft_lora_eval.py"), "--job", str(out_dir / "job.json")])
    return json.loads((out_dir / "eval-result.json").read_text(encoding="utf-8"))


def _judge_mode(
    *,
    control: str,
    mode: dict[str, Any],
    base: dict[str, Any],
    adapter: dict[str, Any],
    train: dict[str, Any],
) -> dict[str, Any]:
    thr_mem = THRESHOLDS["memorization"]
    thr_gen = THRESHOLDS["generalization"]
    base_valid = bool(base.get("evaluationValid"))
    adapter_exact = float(adapter.get("exactMatch") or 0.0)
    base_exact = float(base.get("exactMatch") or 0.0)
    improvement = adapter_exact - base_exact
    if control == "memorization":
        checks = {
            "evaluationValid": base_valid,
            "exactMatchPass": adapter_exact >= float(thr_mem["minExactMatchPerMode"]),
            "adapterLoaded": bool(adapter.get("adapterLoaded")),
            "adapterWeightDelta": bool(train.get("adapterWeightsChanged")),
            "sampleSizeOk": int(adapter.get("sampleSize") or 0) >= int(thr_mem["minItems"]),
        }
    else:
        checks = {
            "evaluationValid": base_valid,
            "heldoutExactMatchPass": adapter_exact >= float(thr_gen["minHeldoutExactMatchPerMode"]),
            "improvementPass": improvement >= float(thr_gen["minImprovementOverBasePerMode"]),
            "adapterLoaded": bool(adapter.get("adapterLoaded")),
            "adapterWeightDelta": bool(train.get("adapterWeightsChanged")),
            "sampleSizeOk": int(adapter.get("sampleSize") or 0) >= int(thr_gen["minHeldoutItems"]),
        }
    return {
        "thinkingMode": mode["id"],
        "passed": all(checks.values()),
        "checks": checks,
        "baseExactMatch": base_exact,
        "adapterExactMatch": adapter_exact,
        "improvement": improvement,
        "baseInvalidRate": base.get("invalidRate"),
        "adapterInvalidRate": adapter.get("invalidRate"),
        "baseTruncatedCount": base.get("truncatedCount"),
        "baseNoFinalAnswerCount": base.get("noFinalAnswerCount"),
        "templateFingerprint": {
            "base": base.get("templateFingerprint"),
            "adapter": adapter.get("templateFingerprint"),
            "train": train.get("templateFingerprint"),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["local-smoke", "gpu-controls-v2"], required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=18)
    args = parser.parse_args()

    if args.mode == "local-smoke":
        model_id = THRESHOLDS["localSmoke"]["modelId"]
        counts_as_pass = False
        mem_steps, gen_steps = 40, 80
    else:
        model_id = THRESHOLDS["gpuGate"]["modelId"]
        counts_as_pass = True
        mem_steps, gen_steps = 80, 200

    started = time.time()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    mem_train = _train(
        python=args.python,
        model_id=model_id,
        dataset=PHASE0 / "memorization.jsonl",
        out_dir=out / "memorization" / "train",
        device=args.device,
        steps=mem_steps,
        seed=args.seed,
    )
    gen_train = _train(
        python=args.python,
        model_id=model_id,
        dataset=PHASE0 / "generalization_v2_train.jsonl",
        out_dir=out / "generalization_v2" / "train",
        device=args.device,
        steps=gen_steps,
        seed=args.seed,
    )

    mem_modes = []
    gen_modes = []
    for mode in MODES:
        mem_base = _eval(
            python=args.python,
            model_id=model_id,
            dataset=PHASE0 / "memorization.jsonl",
            out_dir=out / "memorization" / mode["id"] / "base",
            adapter_path=None,
            mode=mode,
            device=args.device,
        )
        mem_adapter = _eval(
            python=args.python,
            model_id=model_id,
            dataset=PHASE0 / "memorization.jsonl",
            out_dir=out / "memorization" / mode["id"] / "adapter",
            adapter_path=mem_train.get("adapterPath"),
            mode=mode,
            device=args.device,
        )
        mem_modes.append(
            _judge_mode(
                control="memorization",
                mode=mode,
                base=mem_base,
                adapter=mem_adapter,
                train=mem_train,
            ),
        )

        gen_base = _eval(
            python=args.python,
            model_id=model_id,
            dataset=PHASE0 / "generalization_v2_heldout.jsonl",
            out_dir=out / "generalization_v2" / mode["id"] / "base",
            adapter_path=None,
            mode=mode,
            device=args.device,
        )
        gen_adapter = _eval(
            python=args.python,
            model_id=model_id,
            dataset=PHASE0 / "generalization_v2_heldout.jsonl",
            out_dir=out / "generalization_v2" / mode["id"] / "adapter",
            adapter_path=gen_train.get("adapterPath"),
            mode=mode,
            device=args.device,
        )
        gen_modes.append(
            _judge_mode(
                control="generalization",
                mode=mode,
                base=gen_base,
                adapter=gen_adapter,
                train=gen_train,
            ),
        )

    mem_pass = all(row["passed"] for row in mem_modes)
    gen_pass = all(row["passed"] for row in gen_modes)
    both = mem_pass and gen_pass
    phase0_pass = bool(counts_as_pass and both)

    report = {
        "specVersion": "c18d-phase0-report-v2",
        "thresholdsVersion": THRESHOLDS["specVersion"],
        "mode": args.mode,
        "status": "pass" if phase0_pass else "fail_or_incomplete",
        "modelId": model_id,
        "memorization": {"passedAllModes": mem_pass, "modes": mem_modes},
        "generalization": {"passedAllModes": gen_pass, "modes": gen_modes},
        "bothControlsPassed": both,
        "countsAsPhase0Pass": counts_as_pass,
        "phase0Passed": phase0_pass,
        "autonomousTrainingUnlocked": phase0_pass,
        "ollamaTouched": False,
        "wallClockMs": int((time.time() - started) * 1000),
        "note": (
            "Local smoke never unlocks autonomous training."
            if args.mode == "local-smoke"
            else "On pass, copy to docs/milestones/C1_8D_PHASE0_GPU_RESULT_V2.json"
        ),
    }
    _write_json(out / "phase0-report-v2.json", report)
    print(json.dumps({
        "phase0Passed": phase0_pass,
        "autonomousTrainingUnlocked": phase0_pass,
        "report": str(out / "phase0-report-v2.json"),
    }, indent=2))
    if args.mode == "gpu-controls-v2" and not phase0_pass:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
