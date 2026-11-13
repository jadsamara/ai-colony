#!/usr/bin/env python3
"""C1.8D Phase 0 corrected controls (thresholds v2.1).

Trains memorization + hidden-rule generalization with enable_thinking=False.
Evaluates base and adapter under both thinking modes; only thinking_disabled
gates the pass (thinking_enabled is informational / OOD for the adapter).
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
THRESHOLDS = json.loads((PHASE0 / "thresholds-v2.1.json").read_text(encoding="utf-8"))
MODES = THRESHOLDS["evaluation"]["modes"]
GATING_MODE = THRESHOLDS["evaluation"]["gatingMode"]


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def _mode_role(mode: dict[str, Any]) -> str:
    return str(mode.get("role") or ("gating" if mode["id"] == GATING_MODE else "informational"))


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
        "phase": "c18d-phase0-v2.1",
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
    role = _mode_role(mode)
    affects_gate = role == "gating"
    base_invalid_rate = float(base.get("invalidRate") or 0.0)
    max_invalid = float(THRESHOLDS["evaluation"]["maxBaseInvalidRate"])
    base_valid = bool(base.get("evaluationValid"))
    if base.get("evaluationValid") is None:
        base_valid = base_invalid_rate <= max_invalid
    adapter_exact = float(adapter.get("exactMatch") or 0.0)
    base_exact = float(base.get("exactMatch") or 0.0)
    improvement = adapter_exact - base_exact
    if control == "memorization":
        checks = {
            "exactMatchPass": adapter_exact >= float(thr_mem["minExactMatchPerMode"]),
            "adapterLoaded": bool(adapter.get("adapterLoaded")),
            "adapterWeightDelta": bool(train.get("adapterWeightsChanged")),
            "sampleSizeOk": int(adapter.get("sampleSize") or 0) >= int(thr_mem["minItems"]),
        }
    else:
        checks = {
            "heldoutExactMatchPass": adapter_exact >= float(thr_gen["minHeldoutExactMatchPerMode"]),
            "improvementPass": improvement >= float(thr_gen["minImprovementOverBasePerMode"]),
            "adapterLoaded": bool(adapter.get("adapterLoaded")),
            "adapterWeightDelta": bool(train.get("adapterWeightsChanged")),
            "sampleSizeOk": int(adapter.get("sampleSize") or 0) >= int(thr_gen["minHeldoutItems"]),
        }
    # maxBaseInvalidRate fails the gate only in the gating mode.
    if affects_gate:
        checks = {"evaluationValid": base_valid, **checks}
    else:
        checks = {
            "evaluationValidReported": base_valid,
            "evaluationValidAffectsGate": False,
            **checks,
        }
    gate_checks = {k: v for k, v in checks.items() if k != "evaluationValidReported" and k != "evaluationValidAffectsGate"}
    if not affects_gate:
        # Informational: accuracy/adapter checks are reported; invalid rate never fails the gate.
        diagnostic_pass = all(
            v for k, v in checks.items()
            if k not in ("evaluationValidReported", "evaluationValidAffectsGate")
        )
        passed = diagnostic_pass
    else:
        passed = all(gate_checks.values())
    return {
        "thinkingMode": mode["id"],
        "role": role,
        "affectsGate": affects_gate,
        "passed": passed,
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


def _gating_row(rows: list[dict[str, Any]]) -> dict[str, Any]:
    for row in rows:
        if row.get("affectsGate"):
            return row
    raise RuntimeError(f"No gating-mode row found (expected {GATING_MODE})")


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

    mem_gating = _gating_row(mem_modes)
    gen_gating = _gating_row(gen_modes)
    mem_pass = bool(mem_gating["passed"])
    gen_pass = bool(gen_gating["passed"])
    require_both = bool(THRESHOLDS["gpuGate"].get("bothControlsMustPassInGatingMode", True))
    both = (mem_pass and gen_pass) if require_both else (mem_pass or gen_pass)
    phase0_pass = bool(counts_as_pass and both)

    report = {
        "specVersion": "c18d-phase0-report-v2.1",
        "thresholdsVersion": THRESHOLDS["specVersion"],
        "mode": args.mode,
        "status": "pass" if phase0_pass else "fail_or_incomplete",
        "modelId": model_id,
        "gatingMode": GATING_MODE,
        "memorization": {
            "passedInGatingMode": mem_pass,
            "gatingMode": mem_gating,
            "modes": mem_modes,
        },
        "generalization": {
            "passedInGatingMode": gen_pass,
            "gatingMode": gen_gating,
            "modes": gen_modes,
        },
        "bothControlsPassedInGatingMode": both,
        "countsAsPhase0Pass": counts_as_pass,
        "phase0Passed": phase0_pass,
        "autonomousTrainingUnlocked": phase0_pass,
        "ollamaTouched": False,
        "wallClockMs": int((time.time() - started) * 1000),
        "note": (
            "Local smoke never unlocks autonomous training."
            if args.mode == "local-smoke"
            else (
                "On pass, copy to docs/milestones/C1_8D_PHASE0_GPU_RESULT_V2.json. "
                "Gate uses thinking_disabled only; thinking_enabled is informational."
            )
        ),
    }
    _write_json(out / "phase0-report-v2.json", report)
    print(json.dumps({
        "phase0Passed": phase0_pass,
        "autonomousTrainingUnlocked": phase0_pass,
        "gatingMode": GATING_MODE,
        "report": str(out / "phase0-report-v2.json"),
    }, indent=2))
    if args.mode == "gpu-controls-v2" and not phase0_pass:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
