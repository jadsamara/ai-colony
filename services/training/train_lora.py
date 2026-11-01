#!/usr/bin/env python3
"""Allowlisted MLX-LM LoRA trainer for Gemma 3 270M arithmetic.

The base safetensors file is hashed before and after. Adapters are saved beside
it and are never merged back into the base checkpoint.
"""

from __future__ import annotations

import time
import types
from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx.utils import tree_flatten
from mlx_lm.lora import train_model
from mlx_lm.tuner.callbacks import TrainingCallback
from mlx_lm.tuner.datasets import load_dataset
from mlx_lm.utils import load

from common import (
    WorkerError,
    artifact_dir,
    assert_training_config,
    base_weight_hash,
    checkpoint_path,
    fail,
    load_job,
    refuse_test_split,
    write_result,
)


class CancelledTraining(Exception):
    pass


class Capture(TrainingCallback):
    def __init__(self, cancel_path: Path):
        self.cancel_path = cancel_path
        self.metrics: list[dict] = []
        self.peak_bytes = 0

    def on_train_loss_report(self, info: dict) -> None:
        self._cancel()
        peak = float(info.get("peak_memory") or 0) * 1_000_000_000
        self.peak_bytes = max(self.peak_bytes, int(peak))
        self.metrics.append(
            {
                "step": int(info["iteration"]),
                "trainLoss": float(info["train_loss"]),
                "validationLoss": None,
                "learningRate": float(info["learning_rate"]),
            }
        )

    def on_val_loss_report(self, info: dict) -> None:
        self._cancel()
        self.metrics.append(
            {
                "step": int(info["iteration"]),
                "trainLoss": None,
                "validationLoss": float(info["val_loss"]),
                "learningRate": None,
            }
        )

    def _cancel(self) -> None:
        if self.cancel_path.exists():
            raise CancelledTraining()


def main() -> None:
    job = load_job(__import__("sys").argv)
    assert_training_config(job)
    model_dir = checkpoint_path(job["modelPath"])
    output = artifact_dir(job["outputDir"])
    data = Path(job["dataDir"]).resolve()
    if not data.is_dir():
        raise WorkerError("training data directory is missing")
    refuse_test_split(data)
    before = base_weight_hash(model_dir)
    started = time.perf_counter()
    if hasattr(mx, "reset_peak_memory"):
        mx.reset_peak_memory()
    np.random.seed(job["seed"])
    model, tokenizer = load(str(model_dir), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
    keys = sorted({name for name, _module in model.layers[0].named_modules() if name.endswith("q_proj") or name.endswith("v_proj")})
    if keys != ["self_attn.q_proj", "self_attn.v_proj"] and not keys:
        raise WorkerError(f"could not find allowlisted projections, saw {keys}")
    if not any(name.endswith("q_proj") for name in keys) or not any(name.endswith("v_proj") for name in keys):
        raise WorkerError(f"allowlisted projections were not found: {keys}")
    args = types.SimpleNamespace(
        model=str(model_dir),
        train=True,
        test=False,
        data=str(data),
        fine_tune_type="lora",
        optimizer="adamw",
        optimizer_config={"adam": {}, "adamw": {}, "sgd": {}, "adafactor": {}},
        seed=job["seed"],
        num_layers=job["numLayers"],
        batch_size=job["batchSize"],
        iters=job["steps"],
        val_batches=8,
        learning_rate=job["learningRate"],
        steps_per_report=1,
        steps_per_eval=20,
        adapter_path=str(output),
        save_every=20,
        max_seq_length=job["maxSeq"],
        grad_checkpoint=True,
        grad_accumulation_steps=job["gradAccum"],
        clear_cache_threshold=0,
        lr_schedule=None,
        lora_parameters={"rank": job["rank"], "dropout": job["dropout"], "scale": job["scale"], "keys": keys},
        mask_prompt=True,
        resume_adapter_file=None,
        trust_remote_code=False,
    )
    callback = Capture(Path(job["cancelPath"]))
    cancelled = False
    try:
        train_set, valid_set, _test_set = load_dataset(args, tokenizer)
        if _test_set:
            raise WorkerError("training loaded a test split")
        train_model(args, model, train_set, valid_set, callback)
    except CancelledTraining:
        cancelled = True
    after = base_weight_hash(model_dir)
    if after != before:
        raise WorkerError("base checkpoint changed during training")
    trainable = sum(value.size for _name, value in tree_flatten(model.trainable_parameters()))
    artifact = output / "adapters.safetensors"
    if not cancelled and (not artifact.is_file() or trainable <= 0):
        raise WorkerError("training did not produce LoRA weights")
    train_losses = [item["trainLoss"] for item in callback.metrics if item["trainLoss"] is not None]
    valid_losses = [item["validationLoss"] for item in callback.metrics if item["validationLoss"] is not None]
    write_result(
        output,
        {
            "cancelled": cancelled,
            "artifactPath": str(artifact) if artifact.is_file() else None,
            "format": "safetensors",
            "durationMs": int((time.perf_counter() - started) * 1000),
            "peakMemoryBytes": int(mx.get_peak_memory()) if hasattr(mx, "get_peak_memory") else callback.peak_bytes,
            "trainLoss": train_losses[-1] if train_losses else None,
            "validationLoss": valid_losses[-1] if valid_losses else None,
            "metrics": callback.metrics,
            "trainableParameters": int(trainable),
            "adaptedModules": keys,
            "baseSha256": after,
            "baseUnchanged": True,
        },
    )


if __name__ == "__main__":
    try:
        main()
    except WorkerError as error:
        fail(str(error))
    except Exception as error:
        fail(f"{type(error).__name__}: {error}")
