#!/usr/bin/env python3
"""Matched two-mode PEFT evaluation (base vs adapter) with invalid-output accounting."""

from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from peft_chat import build_chat_texts, template_fingerprint
from peft_eval_common import EVAL_MODES, score_prediction, summarize_scores


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


def _resolve_mode(job: dict[str, Any]) -> dict[str, Any]:
    mode_id = str(job.get("thinkingMode") or job.get("evalMode") or "thinking_disabled")
    if mode_id not in EVAL_MODES:
        _fail("EVAL_MODE", f"Unknown thinkingMode {mode_id}")
    mode = dict(EVAL_MODES[mode_id])
    if job.get("maxNewTokens") is not None:
        mode["maxNewTokens"] = int(job["maxNewTokens"])
    if job.get("enableThinking") is not None:
        mode["enableThinking"] = bool(job["enableThinking"])
    return mode


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
    mode = _resolve_mode(job)
    max_new_tokens = int(mode["maxNewTokens"])
    enable_thinking = bool(mode["enableThinking"])
    max_invalid = float(job.get("maxBaseInvalidRate") or 0.05)

    started = time.time()
    load_started = time.time()
    tokenizer = AutoTokenizer.from_pretrained(
        model_id,
        revision=tokenizer_revision,
        trust_remote_code=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tmpl_fp = template_fingerprint(tokenizer)

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
        adapter_names = [name for name, _ in model.named_parameters() if "lora_" in name]
        adapter_loaded = len(adapter_names) > 0
        if not adapter_loaded:
            _fail("ADAPTER_NOT_LOADED", f"No LoRA parameters found under {adapter_path}")
    load_ms = int((time.time() - load_started) * 1000)
    resolved_model_revision = revision or getattr(base.config, "_commit_hash", None)
    resolved_tokenizer_revision = tokenizer_revision or getattr(tokenizer, "name_or_path", None)

    eval_started = time.time()
    predictions: list[dict[str, Any]] = []
    with torch.no_grad():
        for row in rows:
            prompt, _ = build_chat_texts(
                tokenizer,
                str(row["user"]),
                None,
                enable_thinking=enable_thinking,
            )
            inputs = tokenizer(prompt, return_tensors="pt")
            inputs = {key: value.to(device) for key, value in inputs.items()}
            generated = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
                return_dict_in_generate=True,
            )
            sequences = generated.sequences
            new_tokens = sequences[0][inputs["input_ids"].shape[-1] :]
            truncated = int(new_tokens.shape[0]) >= max_new_tokens
            # If EOS present in new tokens, not truncated.
            if tokenizer.eos_token_id is not None and tokenizer.eos_token_id in set(new_tokens.tolist()):
                truncated = False
            text = tokenizer.decode(new_tokens, skip_special_tokens=True)
            scored = score_prediction(
                text,
                str(row["assistant"]),
                enable_thinking=enable_thinking,
                truncated=truncated,
            )
            predictions.append(
                {
                    "id": row.get("id"),
                    "rawPrediction": text,
                    **scored,
                },
            )

    summary = summarize_scores(predictions, max_base_invalid_rate=max_invalid)
    eval_ms = int((time.time() - eval_started) * 1000)
    duration_ms = int((time.time() - started) * 1000)
    result = {
        "ok": True,
        "modelId": model_id,
        "modelRevision": revision,
        "tokenizerRevision": tokenizer_revision,
        "resolvedModelRevision": resolved_model_revision,
        "resolvedTokenizerRevision": resolved_tokenizer_revision,
        "adapterPath": adapter_path,
        "adapterLoaded": adapter_loaded if adapter_path else False,
        "evaluatedWithAdapter": bool(adapter_path) and adapter_loaded,
        "thinkingMode": mode["id"],
        "enableThinking": enable_thinking,
        "maxNewTokens": max_new_tokens,
        "templateFingerprint": tmpl_fp,
        "device": device,
        "durationMs": duration_ms,
        "timing": {
            "modelLoadMs": load_ms,
            "evalMs": eval_ms,
            "wallClockMs": duration_ms,
        },
        "examplesPerSec": (len(rows) / (eval_ms / 1000.0)) if eval_ms else None,
        "predictions": predictions,
        "ollamaTouched": False,
        **summary,
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
