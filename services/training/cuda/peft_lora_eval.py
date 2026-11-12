#!/usr/bin/env python3
"""Evaluate base vs adapter generations; prove the adapter is loaded."""

from __future__ import annotations

import json
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from peft_chat import build_chat_texts


def _fail(code: str, message: str) -> None:
    raise RuntimeError(f"{code}: {message}")


def _load_job(argv: list[str]) -> dict[str, Any]:
    if len(argv) < 3 or argv[1] != "--job":
        _fail("INVALID_ARGS", "Usage: peft_lora_eval.py --job <path>")
    return json.loads(Path(argv[2]).read_text(encoding="utf-8"))


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


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


def evaluate(job: dict[str, Any]) -> dict[str, Any]:
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    rows = _read_jsonl(Path(str(job["datasetPath"])).resolve())
    output = Path(str(job["outputDir"])).resolve()
    output.mkdir(parents=True, exist_ok=True)
    model_id = str(job["modelId"])
    revision = job.get("modelRevision") or None
    tokenizer_revision = job.get("tokenizerRevision") or revision
    adapter_path = job.get("adapterPath")
    device = _pick_device(job)
    max_new_tokens = int(job.get("maxNewTokens") or 32)

    tokenizer = AutoTokenizer.from_pretrained(
        model_id,
        revision=tokenizer_revision,
        trust_remote_code=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    started = time.time()
    base = AutoModelForCausalLM.from_pretrained(
        model_id,
        revision=revision,
        trust_remote_code=True,
        torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32,
    )
    if device != "cpu":
        base.to(device)
    base.eval()

    adapter_loaded = False
    model = base
    if adapter_path:
        model = PeftModel.from_pretrained(base, adapter_path)
        if device != "cpu":
            model.to(device)
        model.eval()
        # Prove adapter modules exist and are active.
        adapter_names = [name for name, _ in model.named_parameters() if "lora_" in name]
        adapter_loaded = len(adapter_names) > 0
        if not adapter_loaded:
            _fail("ADAPTER_NOT_LOADED", f"No LoRA parameters found under {adapter_path}")

    correct = 0
    predictions: list[dict[str, Any]] = []
    with torch.no_grad():
        for row in rows:
            prompt, _ = build_chat_texts(tokenizer, str(row["user"]), None)
            inputs = tokenizer(prompt, return_tensors="pt")
            inputs = {key: value.to(device) for key, value in inputs.items()}
            generated = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
            )
            new_tokens = generated[0][inputs["input_ids"].shape[-1] :]
            text = tokenizer.decode(new_tokens, skip_special_tokens=True)
            expected = str(row["assistant"])
            ok = _normalize(text) == _normalize(expected) or _normalize(expected) in _normalize(text)
            correct += int(ok)
            predictions.append(
                {
                    "id": row.get("id"),
                    "expected": expected,
                    "prediction": text,
                    "exactMatch": ok,
                },
            )

    duration_ms = int((time.time() - started) * 1000)
    total = len(rows)
    result = {
        "ok": True,
        "modelId": model_id,
        "adapterPath": adapter_path,
        "adapterLoaded": adapter_loaded if adapter_path else False,
        "evaluatedWithAdapter": bool(adapter_path) and adapter_loaded,
        "sampleSize": total,
        "exactMatch": (correct / total) if total else 0.0,
        "correct": correct,
        "durationMs": duration_ms,
        "examplesPerSec": (total / (duration_ms / 1000.0)) if duration_ms else None,
        "device": device,
        "predictions": predictions,
        "ollamaTouched": False,
    }
    _write_json(output / "eval-result.json", result)
    return result


def main() -> None:
    try:
        job = _load_job(sys.argv)
        evaluate(job)
    except Exception as error:
        traceback.print_exc()
        try:
            raw = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
            out = Path(str(raw.get("outputDir") or "/tmp")).resolve()
            _write_json(out / "eval-result.json", {"ok": False, "error": str(error)})
        except Exception:
            pass
        raise SystemExit(1)


if __name__ == "__main__":
    main()
