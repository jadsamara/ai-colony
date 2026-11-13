#!/usr/bin/env python3
"""C1.8D Phase 0 positive controls (thresholds v3).

Fresh train + eval under thinking_disabled gating with conservative
worst-case accuracy bounds. thinking_enabled is skipped by default on
GPU controls (still available via --run-thinking-enabled).
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
THRESHOLDS = json.loads((PHASE0 / "thresholds-v3.json").read_text(encoding="utf-8"))
MODES = THRESHOLDS["evaluation"]["modes"]
GATING_MODE = THRESHOLDS["evaluation"]["gatingMode"]
HP = THRESHOLDS["trainingHyperparameters"]


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def _mode_role(mode: dict[str, Any]) -> str:
    return str(mode.get("role") or ("gating" if mode["id"] == GATING_MODE else "informational"))


def _select_modes(*, skip_thinking_enabled: bool) -> list[dict[str, Any]]:
    if not skip_thinking_enabled:
        return list(MODES)
    return [mode for mode in MODES if mode["id"] != "thinking_enabled"]


def _train(
    *,
    python: str,
    model_id: str,
    dataset: Path,
    out_dir: Path,
    device: str,
    steps: int,
    seed: int,
) -> tuple[dict[str, Any], dict[str, int]]:
    if out_dir.exists() and any(out_dir.iterdir()):
        raise RuntimeError(
            f"Refusing to reuse non-empty output dir {out_dir}; "
            "v3 requires fresh adapters (do not reuse v2.1 artifacts).",
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "backend": "peft-lora",
        "allowGpuTraining": True,
        "phase": "c18d-phase0-v3",
        "modelId": model_id,
        "datasetPath": str(dataset),
        "outputDir": str(out_dir),
        "seed": seed,
        "steps": steps,
        "learningRate": float(HP["learningRate"]),
        "loraRank": int(HP["loraRank"]),
        "loraAlpha": int(HP["loraAlpha"]),
        "batchSize": int(HP["batchSize"]),
        "gradAccum": int(HP["gradAccum"]),
        "maxSeqLen": int(HP["maxSeqLen"]),
        "device": device,
        "downloadWeights": True,
    }
    _write_json(out_dir / "job.json", job)
    wall_started = time.time()
    _run([python, str(ROOT / "peft_lora_train.py"), "--job", str(out_dir / "job.json")])
    wall_ms = int((time.time() - wall_started) * 1000)
    result = json.loads((out_dir / "result.json").read_text(encoding="utf-8"))
    timing = dict(result.get("timing") or {})
    timing["runnerWallClockMs"] = wall_ms
    return result, timing


def _eval(
    *,
    python: str,
    model_id: str,
    dataset: Path,
    out_dir: Path,
    adapter_path: str | None,
    mode: dict[str, Any],
    device: str,
) -> tuple[dict[str, Any], dict[str, int]]:
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
    }
    _write_json(out_dir / "job.json", job)
    wall_started = time.time()
    _run([python, str(ROOT / "peft_lora_eval.py"), "--job", str(out_dir / "job.json")])
    wall_ms = int((time.time() - wall_started) * 1000)
    result = json.loads((out_dir / "eval-result.json").read_text(encoding="utf-8"))
    timing = dict(result.get("timing") or {})
    timing["runnerWallClockMs"] = wall_ms
    return result, timing


def _counts(result: dict[str, Any]) -> dict[str, Any]:
    correct = int(result.get("correct") or 0)
    wrong = int(result.get("wrong") or 0)
    invalid = int(result.get("invalid") or 0)
    total = correct + wrong + invalid
    sample = int(result.get("sampleSize") or total)
    observed = (correct / sample) if sample else 0.0
    upper = ((correct + invalid) / sample) if sample else 0.0
    lower = (correct / sample) if sample else 0.0
    return {
        "correct": correct,
        "wrong": wrong,
        "invalid": invalid,
        "sampleSize": sample,
        "countsConsistent": sample == total,
        "observedAccuracy": observed,
        "upperBoundAccuracy": upper,
        "lowerBoundAccuracy": lower,
        "invalidRate": float(result.get("invalidRate") or 0.0),
        "truncatedCount": result.get("truncatedCount"),
        "noFinalAnswerCount": result.get("noFinalAnswerCount"),
    }


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
    base_counts = _counts(base)
    adapter_counts = _counts(adapter)
    base_upper = float(base_counts["upperBoundAccuracy"])
    adapter_lower = float(adapter_counts["lowerBoundAccuracy"])
    conservative_improvement = adapter_lower - base_upper
    observed_improvement = float(adapter_counts["observedAccuracy"]) - float(base_counts["observedAccuracy"])

    if control == "memorization":
        checks = {
            "countsConsistent": bool(base_counts["countsConsistent"] and adapter_counts["countsConsistent"]),
            "adapterLowerBoundPass": adapter_lower >= float(thr_mem["minAdapterLowerBoundAccuracy"]),
            "adapterLoaded": bool(adapter.get("adapterLoaded")),
            "adapterWeightDelta": bool(train.get("adapterWeightsChanged")),
            "sampleSizeOk": int(adapter_counts["sampleSize"]) >= int(thr_mem["minItems"]),
        }
        if thr_mem.get("requireImprovementOverBase"):
            checks["improvementPass"] = conservative_improvement >= 0
    else:
        checks = {
            "countsConsistent": bool(base_counts["countsConsistent"] and adapter_counts["countsConsistent"]),
            "heldoutLowerBoundPass": adapter_lower >= float(thr_gen["minAdapterLowerBoundAccuracy"]),
            "conservativeImprovementPass": (
                conservative_improvement >= float(thr_gen["minConservativeImprovementOverBase"])
            ),
            "adapterLoaded": bool(adapter.get("adapterLoaded")),
            "adapterWeightDelta": bool(train.get("adapterWeightsChanged")),
            "sampleSizeOk": int(adapter_counts["sampleSize"]) >= int(thr_gen["minHeldoutItems"]),
        }

    diagnostic_passed = all(checks.values())
    # Only gating-mode rows can pass the gate.
    passed = diagnostic_passed if affects_gate else False

    return {
        "thinkingMode": mode["id"],
        "role": role,
        "affectsGate": affects_gate,
        "passed": passed,
        "diagnosticPassed": diagnostic_passed,
        "checks": checks,
        "sampleSize": adapter_counts["sampleSize"],
        "base": base_counts,
        "adapter": adapter_counts,
        "baseUpperBoundAccuracy": base_upper,
        "adapterLowerBoundAccuracy": adapter_lower,
        "conservativeImprovement": conservative_improvement,
        "observedImprovement": observed_improvement,
        "observedBaseAccuracy": base_counts["observedAccuracy"],
        "observedAdapterAccuracy": adapter_counts["observedAccuracy"],
        "adapterLoaded": bool(adapter.get("adapterLoaded")),
        "adapterWeightsChanged": bool(train.get("adapterWeightsChanged")),
        "adapterFingerprint": train.get("adapterFingerprint"),
        "resolvedModelRevision": adapter.get("resolvedModelRevision") or train.get("resolvedModelRevision"),
        "resolvedTokenizerRevision": (
            adapter.get("resolvedTokenizerRevision") or train.get("resolvedTokenizerRevision")
        ),
        "templateFingerprint": {
            "base": base.get("templateFingerprint"),
            "adapter": adapter.get("templateFingerprint"),
            "train": train.get("templateFingerprint"),
        },
        "matchedDecoding": {
            "enableThinking": mode["enableThinking"],
            "maxNewTokens": mode["maxNewTokens"],
            "doSample": False,
        },
    }


def _gating_row(rows: list[dict[str, Any]]) -> dict[str, Any]:
    for row in rows:
        if row.get("affectsGate"):
            return row
    raise RuntimeError(f"No gating-mode row found (expected {GATING_MODE})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["local-smoke", "gpu-controls-v3"], required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=int(HP["seed"]))
    parser.add_argument(
        "--run-thinking-enabled",
        action="store_true",
        help="Also run informational thinking_enabled eval (skipped by default on v3 GPU).",
    )
    parser.add_argument(
        "--skip-thinking-enabled",
        action="store_true",
        default=False,
        help="Explicit skip (default behavior for gpu-controls-v3).",
    )
    args = parser.parse_args()

    if args.mode == "local-smoke":
        model_id = THRESHOLDS["localSmoke"]["modelId"]
        mem_steps, gen_steps = 40, 80
        skip_thinking = not args.run_thinking_enabled
    else:
        model_id = THRESHOLDS["gpuGate"]["modelId"]
        mem_steps = int(HP["memorizationSteps"])
        gen_steps = int(HP["generalizationSteps"])
        # Default: skip thinking_enabled on GPU unless --run-thinking-enabled.
        skip_thinking = not args.run_thinking_enabled

    if args.skip_thinking_enabled:
        skip_thinking = True

    modes = _select_modes(skip_thinking_enabled=skip_thinking)
    if not any(mode["id"] == GATING_MODE for mode in modes):
        raise RuntimeError(f"Gating mode {GATING_MODE} missing from selected eval modes")

    started = time.time()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    timing_summary: dict[str, Any] = {
        "train": {},
        "eval": {},
        "modelLoadMsTotal": 0,
        "trainMsTotal": 0,
        "evalMsTotal": 0,
    }

    mem_train, mem_train_timing = _train(
        python=args.python,
        model_id=model_id,
        dataset=PHASE0 / "memorization.jsonl",
        out_dir=out / "memorization" / "train",
        device=args.device,
        steps=mem_steps,
        seed=args.seed,
    )
    gen_train, gen_train_timing = _train(
        python=args.python,
        model_id=model_id,
        dataset=PHASE0 / "generalization_v2_train.jsonl",
        out_dir=out / "generalization_v2" / "train",
        device=args.device,
        steps=gen_steps,
        seed=args.seed,
    )
    timing_summary["train"]["memorization"] = mem_train_timing
    timing_summary["train"]["generalization"] = gen_train_timing
    timing_summary["modelLoadMsTotal"] += int(mem_train_timing.get("modelLoadMs") or 0)
    timing_summary["modelLoadMsTotal"] += int(gen_train_timing.get("modelLoadMs") or 0)
    timing_summary["trainMsTotal"] += int(mem_train_timing.get("trainMs") or 0)
    timing_summary["trainMsTotal"] += int(gen_train_timing.get("trainMs") or 0)

    mem_modes: list[dict[str, Any]] = []
    gen_modes: list[dict[str, Any]] = []
    for mode in modes:
        mem_base, mem_base_t = _eval(
            python=args.python,
            model_id=model_id,
            dataset=PHASE0 / "memorization.jsonl",
            out_dir=out / "memorization" / mode["id"] / "base",
            adapter_path=None,
            mode=mode,
            device=args.device,
        )
        mem_adapter, mem_adapter_t = _eval(
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
        timing_summary["eval"][f"memorization:{mode['id']}:base"] = mem_base_t
        timing_summary["eval"][f"memorization:{mode['id']}:adapter"] = mem_adapter_t

        gen_base, gen_base_t = _eval(
            python=args.python,
            model_id=model_id,
            dataset=PHASE0 / "generalization_v2_heldout.jsonl",
            out_dir=out / "generalization_v2" / mode["id"] / "base",
            adapter_path=None,
            mode=mode,
            device=args.device,
        )
        gen_adapter, gen_adapter_t = _eval(
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
        timing_summary["eval"][f"generalization:{mode['id']}:base"] = gen_base_t
        timing_summary["eval"][f"generalization:{mode['id']}:adapter"] = gen_adapter_t
        for t in (mem_base_t, mem_adapter_t, gen_base_t, gen_adapter_t):
            timing_summary["modelLoadMsTotal"] += int(t.get("modelLoadMs") or 0)
            timing_summary["evalMsTotal"] += int(t.get("evalMs") or 0)

    mem_gating = _gating_row(mem_modes)
    gen_gating = _gating_row(gen_modes)
    mem_pass = bool(mem_gating["passed"])
    gen_pass = bool(gen_gating["passed"])
    require_both = bool(THRESHOLDS["gpuGate"].get("bothControlsMustPassInGatingMode", True))
    both = (mem_pass and gen_pass) if require_both else (mem_pass or gen_pass)

    # countsAsPhase0Pass must equal phase0Passed (local smoke never passes).
    phase0_pass = bool(args.mode == "gpu-controls-v3" and both)
    counts_as_pass = phase0_pass

    report = {
        "specVersion": "c18d-phase0-report-v3",
        "thresholdsVersion": THRESHOLDS["specVersion"],
        "mode": args.mode,
        "status": "pass" if phase0_pass else "fail_or_incomplete",
        "modelId": model_id,
        "gatingMode": GATING_MODE,
        "comparisonMethod": THRESHOLDS["evaluation"]["comparisonMethod"],
        "thinkingEnabledSkipped": skip_thinking,
        "thinkingEnabledSkipReason": (
            "Default for v3 GPU controls; evaluator retained. "
            "v2.1 diagnostic: generalization adapter 85% invalid and memorization adapter "
            "100% invalid in thinking_enabled — causality not established."
            if skip_thinking
            else None
        ),
        "v21DiagnosticCarryForward": THRESHOLDS.get("v21DiagnosticCarryForward"),
        "freshAdapters": True,
        "seed": args.seed,
        "trainingConfig": {
            "memorizationSteps": mem_steps,
            "generalizationSteps": gen_steps,
            "learningRate": HP["learningRate"],
            "loraRank": HP["loraRank"],
            "loraAlpha": HP["loraAlpha"],
            "batchSize": HP["batchSize"],
            "gradAccum": HP["gradAccum"],
            "maxSeqLen": HP["maxSeqLen"],
            "enableThinking": False,
            "unchangedFromV21": HP.get("unchangedFromV21", True),
        },
        "immutableArtifacts": {
            "memorization": {
                "adapterPath": mem_train.get("adapterPath"),
                "adapterFingerprint": mem_train.get("adapterFingerprint"),
                "resolvedModelRevision": mem_train.get("resolvedModelRevision"),
                "resolvedTokenizerRevision": mem_train.get("resolvedTokenizerRevision"),
                "templateFingerprint": mem_train.get("templateFingerprint"),
                "seed": mem_train.get("seed"),
            },
            "generalization": {
                "adapterPath": gen_train.get("adapterPath"),
                "adapterFingerprint": gen_train.get("adapterFingerprint"),
                "resolvedModelRevision": gen_train.get("resolvedModelRevision"),
                "resolvedTokenizerRevision": gen_train.get("resolvedTokenizerRevision"),
                "templateFingerprint": gen_train.get("templateFingerprint"),
                "seed": gen_train.get("seed"),
            },
        },
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
        "phase0Passed": phase0_pass,
        "countsAsPhase0Pass": counts_as_pass,
        "autonomousTrainingUnlocked": phase0_pass,
        "autonomousUnlockNote": (
            "Scheduler must independently re-validate counts/bounds; "
            "do not trust this boolean alone."
        ),
        "ollamaTouched": False,
        "timing": timing_summary,
        "wallClockMs": int((time.time() - started) * 1000),
        "note": (
            "Local smoke never unlocks autonomous training."
            if args.mode == "local-smoke"
            else (
                "On independently validated pass, copy to "
                "docs/milestones/C1_8D_PHASE0_GPU_RESULT_V3.json. "
                "Gate uses thinking_disabled + conservative bounds; "
                "prior v2/v2.1 reports remain unchanged."
            )
        ),
    }
    _write_json(out / "phase0-report-v3.json", report)
    print(json.dumps({
        "phase0Passed": phase0_pass,
        "countsAsPhase0Pass": counts_as_pass,
        "autonomousTrainingUnlocked": phase0_pass,
        "gatingMode": GATING_MODE,
        "thinkingEnabledSkipped": skip_thinking,
        "report": str(out / "phase0-report-v3.json"),
    }, indent=2))
    if args.mode == "gpu-controls-v3" and not phase0_pass:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
