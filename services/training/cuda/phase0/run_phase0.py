#!/usr/bin/env python3
"""C1.8D Phase 0 positive-control runner.

Modes:
  --mode local-smoke   Qwen3-0.6B on CPU/MPS (does NOT pass Phase 0)
  --mode gpu-controls  Qwen3-8B on CUDA (operator-run on GPU VM)

Never touches Ollama. Writes a machine-readable report under --out.
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
THRESHOLDS = json.loads((PHASE0 / "thresholds.json").read_text(encoding="utf-8"))


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def _train_and_eval(
    *,
    python: str,
    model_id: str,
    control_id: str,
    train_path: Path,
    eval_path: Path,
    out_dir: Path,
    device: str,
    steps: int,
    seed: int,
    allow_download: bool,
) -> dict[str, Any]:
    train_out = out_dir / control_id / "train"
    eval_base_out = out_dir / control_id / "eval-base"
    eval_adapter_out = out_dir / control_id / "eval-adapter"
    train_out.mkdir(parents=True, exist_ok=True)
    eval_base_out.mkdir(parents=True, exist_ok=True)
    eval_adapter_out.mkdir(parents=True, exist_ok=True)

    train_job = {
        "backend": "peft-lora",
        "allowGpuTraining": True,
        "phase": "c18d-phase0",
        "modelId": model_id,
        "modelRevision": None,
        "tokenizerRevision": None,
        "datasetPath": str(train_path),
        "outputDir": str(train_out),
        "seed": seed,
        "steps": steps,
        "learningRate": 2e-4,
        "loraRank": 8,
        "loraAlpha": 16,
        "batchSize": 1,
        "gradAccum": 4,
        "maxSeqLen": 192,
        "device": device,
        "downloadWeights": allow_download,
    }
    _write_json(train_out / "job.json", train_job)
    _run([python, str(ROOT / "peft_lora_train.py"), "--job", str(train_out / "job.json")])
    train_result = json.loads((train_out / "result.json").read_text(encoding="utf-8"))

    base_job = {
        "modelId": model_id,
        "datasetPath": str(eval_path),
        "outputDir": str(eval_base_out),
        "adapterPath": None,
        "device": device,
        "maxNewTokens": 24,
    }
    _write_json(eval_base_out / "job.json", base_job)
    _run([python, str(ROOT / "peft_lora_eval.py"), "--job", str(eval_base_out / "job.json")])
    base_eval = json.loads((eval_base_out / "eval-result.json").read_text(encoding="utf-8"))

    adapter_job = {
        **base_job,
        "outputDir": str(eval_adapter_out),
        "adapterPath": train_result.get("adapterPath"),
    }
    _write_json(eval_adapter_out / "job.json", adapter_job)
    _run([python, str(ROOT / "peft_lora_eval.py"), "--job", str(eval_adapter_out / "job.json")])
    adapter_eval = json.loads((eval_adapter_out / "eval-result.json").read_text(encoding="utf-8"))

    return {
        "train": train_result,
        "evalBase": base_eval,
        "evalAdapter": adapter_eval,
    }


def _judge_memorization(bundle: dict[str, Any]) -> dict[str, Any]:
    thr = THRESHOLDS["memorization"]
    adapter = bundle["evalAdapter"]
    train = bundle["train"]
    exact = float(adapter.get("exactMatch") or 0.0)
    checks = {
        "exactMatchPass": exact >= float(thr["minExactMatch"]),
        "adapterLoaded": bool(adapter.get("adapterLoaded")),
        "adapterWeightDelta": bool(train.get("adapterWeightsChanged")),
        "sampleSizeOk": int(adapter.get("sampleSize") or 0) >= int(thr["minItems"]),
    }
    return {
        "controlId": thr["controlId"],
        "passed": all(checks.values()),
        "exactMatch": exact,
        "threshold": thr["minExactMatch"],
        "checks": checks,
    }


def _judge_generalization(bundle: dict[str, Any]) -> dict[str, Any]:
    thr = THRESHOLDS["generalization"]
    base = bundle["evalBase"]
    adapter = bundle["evalAdapter"]
    train = bundle["train"]
    heldout = float(adapter.get("exactMatch") or 0.0)
    base_score = float(base.get("exactMatch") or 0.0)
    improvement = heldout - base_score
    checks = {
        "heldoutExactMatchPass": heldout >= float(thr["minHeldoutExactMatch"]),
        "improvementPass": improvement >= float(thr["minImprovementOverBase"]),
        "adapterLoaded": bool(adapter.get("adapterLoaded")),
        "adapterWeightDelta": bool(train.get("adapterWeightsChanged")),
        "sampleSizeOk": int(adapter.get("sampleSize") or 0) >= int(thr["minHeldoutItems"]),
    }
    return {
        "controlId": thr["controlId"],
        "passed": all(checks.values()),
        "heldoutExactMatch": heldout,
        "baseExactMatch": base_score,
        "improvement": improvement,
        "thresholds": {
            "minHeldoutExactMatch": thr["minHeldoutExactMatch"],
            "minImprovementOverBase": thr["minImprovementOverBase"],
        },
        "checks": checks,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="C1.8D Phase 0 positive controls")
    parser.add_argument("--mode", choices=["local-smoke", "gpu-controls"], required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=18)
    parser.add_argument("--allow-download", action="store_true")
    args = parser.parse_args()

    if args.mode == "local-smoke":
        model_id = THRESHOLDS["localSmoke"]["modelId"]
        mem_steps = 40
        gen_steps = 60
        counts_as_pass = False
    else:
        model_id = THRESHOLDS["gpuGate"]["modelId"]
        mem_steps = 80
        gen_steps = 120
        counts_as_pass = True

    started = time.time()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    mem = _train_and_eval(
        python=args.python,
        model_id=model_id,
        control_id="memorization",
        train_path=PHASE0 / "memorization.jsonl",
        eval_path=PHASE0 / "memorization.jsonl",
        out_dir=out,
        device=args.device,
        steps=mem_steps,
        seed=args.seed,
        allow_download=args.allow_download,
    )
    gen = _train_and_eval(
        python=args.python,
        model_id=model_id,
        control_id="generalization",
        train_path=PHASE0 / "generalization_train.jsonl",
        eval_path=PHASE0 / "generalization_heldout.jsonl",
        out_dir=out,
        device=args.device,
        steps=gen_steps,
        seed=args.seed,
        allow_download=args.allow_download,
    )

    mem_judge = _judge_memorization(mem)
    gen_judge = _judge_generalization(gen)
    both = bool(mem_judge["passed"] and gen_judge["passed"])
    phase0_pass = bool(counts_as_pass and both)

    report = {
        "specVersion": "c18d-phase0-report-v1",
        "mode": args.mode,
        "modelId": model_id,
        "thresholds": THRESHOLDS,
        "memorization": mem_judge,
        "generalization": gen_judge,
        "bothControlsPassed": both,
        "countsAsPhase0Pass": counts_as_pass,
        "phase0Passed": phase0_pass,
        "autonomousTrainingUnlocked": phase0_pass,
        "ollamaTouched": False,
        "wallClockMs": int((time.time() - started) * 1000),
        "artifacts": {
            "memorizationTrain": str(out / "memorization" / "train" / "result.json"),
            "generalizationTrain": str(out / "generalization" / "train" / "result.json"),
        },
        "note": (
            "Local smoke never unlocks autonomous training."
            if args.mode == "local-smoke"
            else "Copy this report into docs/milestones/C1_8D_PHASE0_GPU_RESULT.json after a real GPU run."
        ),
    }
    _write_json(out / "phase0-report.json", report)
    print(json.dumps({
        "phase0Passed": report["phase0Passed"],
        "bothControlsPassed": both,
        "mode": args.mode,
        "report": str(out / "phase0-report.json"),
    }, indent=2))
    if args.mode == "gpu-controls" and not phase0_pass:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
