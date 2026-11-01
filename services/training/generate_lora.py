#!/usr/bin/env python3
"""Greedy generation for the frozen baseline or a trained LoRA candidate."""

from __future__ import annotations

import json
import struct
from pathlib import Path

import mlx.core as mx
from mlx_lm import generate, load
from mlx_lm.sample_utils import make_sampler

from common import WorkerError, artifact_dir, base_weight_hash, checkpoint_path, fail, load_job, sha256_file


def predict(with_adapter: bool) -> None:
    job = load_job(__import__("sys").argv)
    if job.get("temperature") != 0 or job.get("maxTokens") != 8:
        raise WorkerError("experimental decoding is greedy and capped at 8 tokens")
    prompts = job.get("prompts")
    if not isinstance(prompts, list) or not prompts:
        raise WorkerError("prompts are required")
    model_dir = checkpoint_path(job["modelPath"])
    destination = Path(job["outputPath"]).resolve()
    artifact_dir(str(destination.parent))
    before = base_weight_hash(model_dir)
    adapter = job.get("adapterPath")
    loaded_adapter = False
    if with_adapter:
        if not adapter:
            raise WorkerError("candidate generation requires an adapter")
        adapter_path = Path(adapter).resolve()
        weights = adapter_path / "adapters.safetensors" if adapter_path.is_dir() else adapter_path
        if weights.name != "adapters.safetensors":
            raise WorkerError("candidate adapter filename is not allowlisted")
        actual = sha256_file(weights)
        if actual != job.get("expectedAdapterSha256"):
            raise WorkerError("adapter checksum does not match the trained artifact")
        raw = weights.read_bytes()
        header_len = struct.unpack_from("<Q", raw)[0]
        if b"lora" not in raw[8 : 8 + header_len].lower():
            raise WorkerError("adapter file does not contain LoRA tensors")
        model, tokenizer = load(str(model_dir), adapter_path=str(weights.parent), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
        loaded_adapter = True
    else:
        model, tokenizer = load(str(model_dir), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
    sampler = make_sampler(temp=0.0)
    predictions = []
    for prompt in prompts:
        templated = tokenizer.apply_chat_template([{"role": "user", "content": str(prompt)}], add_generation_prompt=True, tokenize=False)
        predictions.append(generate(model, tokenizer, prompt=templated, max_tokens=8, sampler=sampler, verbose=False).strip())
    mx.eval(model.parameters())
    if base_weight_hash(model_dir) != before:
        raise WorkerError("base checkpoint changed during inference")
    destination.write_text(json.dumps({"predictions": predictions, "loadedAdapter": loaded_adapter, "baseSha256": before}))


def main() -> None:
    predict(with_adapter=Path(__file__).name == "generate_lora.py")


if __name__ == "__main__":
    try:
        main()
    except WorkerError as error:
        fail(str(error))
    except Exception as error:
        fail(f"{type(error).__name__}: {error}")
