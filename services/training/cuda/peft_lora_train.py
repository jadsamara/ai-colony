#!/usr/bin/env python3
"""C1.8D PEFT LoRA trainer for HF Qwen3 weights (not Ollama artifacts).

Explicitly separate from the C1.8C dry-run sandbox entrypoint.
Requires job.allowGpuTraining=true for CUDA/MPS/CPU training modes.
Never writes under Ollama volumes.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from peft_chat import tokenize_with_prompt_mask


def _fail(code: str, message: str) -> None:
    raise RuntimeError(f"{code}: {message}")


def _load_job(argv: list[str]) -> dict[str, Any]:
    if len(argv) < 3 or argv[1] != "--job":
        _fail("INVALID_ARGS", "Usage: peft_lora_train.py --job <path>")
    path = Path(argv[2]).resolve()
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def _pick_device(job: dict[str, Any]) -> str:
    import torch

    requested = str(job.get("device") or "auto")
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _library_versions() -> dict[str, str]:
    import torch
    import transformers
    import peft

    return {
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "peft": peft.__version__,
        "cuda_available": str(__import__("torch").cuda.is_available()),
        "cuda_device_name": (
            __import__("torch").cuda.get_device_name(0)
            if __import__("torch").cuda.is_available()
            else None
        ),
    }


def _set_seed(seed: int) -> None:
    import torch

    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def _adapter_fingerprint(adapter_dir: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    paths = sorted(adapter_dir.rglob("*"))
    for path in paths:
        if path.is_file():
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def train(job: dict[str, Any]) -> dict[str, Any]:
    if job.get("allowGpuTraining") is not True:
        _fail("GPU_LOCKED", "Set allowGpuTraining=true for Phase 0 / PEFT training jobs")
    if "ollama" in str(job.get("outputDir", "")).lower():
        _fail("OUTPUT_PATH", "Refusing Ollama output paths")
    if job.get("backend") not in {"peft-lora", "cuda-lora"}:
        _fail("BACKEND", "Expected peft-lora backend")

    import torch
    from torch.utils.data import Dataset as TorchDataset
    from peft import LoraConfig, get_peft_model, TaskType
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        DataCollatorForSeq2Seq,
        Trainer,
        TrainingArguments,
    )

    output = Path(str(job["outputDir"])).resolve()
    output.mkdir(parents=True, exist_ok=True)
    data_path = Path(str(job["datasetPath"])).resolve()
    rows = _read_jsonl(data_path)
    if not rows:
        _fail("DATASET_EMPTY", f"No rows in {data_path}")

    seed = int(job["seed"])
    _set_seed(seed)
    device = _pick_device(job)
    model_id = str(job["modelId"])
    revision = job.get("modelRevision") or None
    tokenizer_revision = job.get("tokenizerRevision") or revision

    started = time.time()
    peak_vram = None
    if device == "cuda" and torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    tokenizer = AutoTokenizer.from_pretrained(
        model_id,
        revision=tokenizer_revision,
        trust_remote_code=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        revision=revision,
        trust_remote_code=True,
        torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32,
    )
    if device != "cpu":
        model.to(device)

    lora = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=int(job.get("loraRank") or 8),
        lora_alpha=int(job.get("loraAlpha") or 16),
        lora_dropout=float(job.get("loraDropout") or 0.05),
        target_modules=job.get("targetModules")
        or ["q_proj", "k_proj", "v_proj", "o_proj", "up_proj", "down_proj", "gate_proj"],
        bias="none",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    # Snapshot a small slice of adapter weights before training for delta check.
    before_vectors: list[float] = []
    for name, param in model.named_parameters():
        if "lora_" in name and param.requires_grad:
            flat = param.detach().float().cpu().view(-1)
            before_vectors.extend(flat[:32].tolist())
            if len(before_vectors) >= 256:
                break

    max_length = int(job.get("maxSeqLen") or 256)

    def _map_row(row: dict[str, Any]) -> dict[str, Any]:
        encoded = tokenize_with_prompt_mask(
            tokenizer,
            str(row["user"]),
            str(row["assistant"]),
            max_length=max_length,
        )
        return {
            "input_ids": encoded["input_ids"],
            "attention_mask": encoded["attention_mask"],
            "labels": encoded["labels"],
        }

    mapped = [_map_row(row) for row in rows]
    probe_masks = [
        tokenize_with_prompt_mask(tokenizer, str(r["user"]), str(r["assistant"]), max_length)
        for r in rows[:3]
    ]
    if any(item["label_token_count"] == 0 for item in probe_masks):
        _fail("MASKING", "Prompt masking left zero supervised tokens; check chat template")

    class _ListDataset(TorchDataset):
        def __init__(self, items: list[dict[str, Any]]):
            self.items = items

        def __len__(self) -> int:
            return len(self.items)

        def __getitem__(self, index: int) -> dict[str, Any]:
            return self.items[index]

    dataset = _ListDataset(mapped)
    collator = DataCollatorForSeq2Seq(tokenizer=tokenizer, padding=True)

    steps = int(job.get("steps") or 50)
    batch_size = int(job.get("batchSize") or 1)
    grad_accum = int(job.get("gradAccum") or 4)
    learning_rate = float(job.get("learningRate") or 2e-4)

    args = TrainingArguments(
        output_dir=str(output / "hf-run"),
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=grad_accum,
        max_steps=steps,
        learning_rate=learning_rate,
        logging_steps=max(1, steps // 10),
        save_steps=max(steps, 1),
        save_total_limit=1,
        report_to=[],
        bf16=device == "cuda",
        fp16=False,
        remove_unused_columns=False,
        seed=seed,
        dataloader_pin_memory=device == "cuda",
    )
    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=dataset,
        data_collator=collator,
    )
    train_result = trainer.train()

    adapter_dir = output / "adapter"
    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)

    after_vectors: list[float] = []
    for name, param in model.named_parameters():
        if "lora_" in name and param.requires_grad:
            flat = param.detach().float().cpu().view(-1)
            after_vectors.extend(flat[:32].tolist())
            if len(after_vectors) >= 256:
                break
    delta = sum(abs(a - b) for a, b in zip(before_vectors, after_vectors))
    adapter_changed = delta > 1e-8

    if device == "cuda" and torch.cuda.is_available():
        peak_vram = int(torch.cuda.max_memory_allocated())

    duration_ms = int((time.time() - started) * 1000)
    examples = len(rows)
    tokens_approx = examples * max_length
    throughput = {
        "examplesPerSec": (examples / (duration_ms / 1000.0)) if duration_ms else None,
        "approxTokensPerSec": (tokens_approx / (duration_ms / 1000.0)) if duration_ms else None,
        "wallClockMs": duration_ms,
        "peakVramBytes": peak_vram,
        "device": device,
    }

    result = {
        "ok": True,
        "dryRun": False,
        "backend": "peft-lora",
        "modelId": model_id,
        "modelRevision": revision,
        "tokenizerRevision": tokenizer_revision,
        "seed": seed,
        "steps": steps,
        "learningRate": learning_rate,
        "loraRank": int(job.get("loraRank") or 8),
        "datasetPath": str(data_path),
        "datasetSize": examples,
        "adapterPath": str(adapter_dir),
        "adapterFingerprint": _adapter_fingerprint(adapter_dir),
        "adapterWeightDelta": delta,
        "adapterWeightsChanged": adapter_changed,
        "chatTemplateUsed": bool(getattr(tokenizer, "chat_template", None)),
        "promptMasking": True,
        "eosTokenId": tokenizer.eos_token_id,
        "libraries": _library_versions(),
        "trainLoss": float(train_result.training_loss) if train_result.training_loss is not None else None,
        "throughput": throughput,
        "ollamaTouched": False,
    }
    _write_json(output / "result.json", result)
    _write_json(output / "config-manifest.json", {
        "backend": "peft-lora",
        "modelId": model_id,
        "modelRevision": revision,
        "tokenizerRevision": tokenizer_revision,
        "seed": seed,
        "steps": steps,
        "learningRate": learning_rate,
        "loraRank": int(job.get("loraRank") or 8),
        "libraries": result["libraries"],
        "phase": job.get("phase", "c18d-phase0"),
    })
    return result


def main() -> None:
    try:
        job = _load_job(sys.argv)
        train(job)
    except Exception as error:
        traceback.print_exc()
        try:
            job_path = Path(sys.argv[2])
            raw = json.loads(job_path.read_text(encoding="utf-8"))
            out = Path(str(raw.get("outputDir") or "/tmp")).resolve()
            _write_json(out / "result.json", {"ok": False, "error": str(error)})
        except Exception:
            pass
        raise SystemExit(1)


if __name__ == "__main__":
    # Avoid inheriting production secrets into training processes.
    for key in list(os.environ):
        upper = key.upper()
        if upper.startswith(("DATABASE_", "POSTGRES_", "RABBITMQ_", "OLLAMA_", "OPENAI_", "ANTHROPIC_")):
            os.environ.pop(key, None)
    main()
