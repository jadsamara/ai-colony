#!/usr/bin/env python3
"""vLLM generation backend for C1.8D.1 (primary evaluation backend).

Primary for Stage A/B development baselines and base-vs-adapter evaluation.
Hugging Face batched remains the independent cross-backend reference.

All requests for a condition are submitted in one ``generate()`` call with
per-request ``SamplingParams(seed=...)`` from ``sampling_seed_schedule``.
"""

from __future__ import annotations

import os
import time
from typing import Any

from decoding import sampling_seed_schedule
from generation_utils import FINAL_ANSWER_INSTRUCTION


BACKEND_ID = "vllm-batched"
BACKEND_STATUS = "primary"
REFERENCE_BACKEND_ID = "huggingface-batched"


def build_prompts(
    items: list[dict[str, Any]],
    tokenizer: Any,
    *,
    enable_thinking: bool,
    build_chat_texts: Any,
    few_shot: str | None = None,
) -> list[str]:
    prompts: list[str] = []
    for item in items:
        user = item["prompt"]
        if few_shot:
            user = few_shot.strip() + "\n\n" + user
        user = f"{user}\n\n{FINAL_ANSWER_INSTRUCTION}"
        prompt, _ = build_chat_texts(
            tokenizer,
            user,
            None,
            enable_thinking=enable_thinking,
        )
        prompts.append(str(prompt))
    return prompts


def sampling_params_kwargs(fields: dict[str, Any], *, seed: int | None = None) -> dict[str, Any]:
    """Map C1.8D.1 decoding fields to vLLM SamplingParams kwargs."""
    kwargs: dict[str, Any] = {
        "max_tokens": int(fields["maxNewTokens"]),
    }
    if fields.get("doSample"):
        kwargs["temperature"] = float(fields["temperature"])
        if fields.get("topP") is not None:
            kwargs["top_p"] = float(fields["topP"])
        if fields.get("topK") is not None:
            kwargs["top_k"] = int(fields["topK"])
    else:
        kwargs["temperature"] = 0.0
    if seed is not None:
        kwargs["seed"] = int(seed)
    return kwargs


def detect_sampler_implementation(llm: Any | None = None) -> dict[str, Any]:
    """Best-effort FlashInfer vs native/Triton sampler recording."""
    env_attn = os.environ.get("VLLM_ATTENTION_BACKEND") or os.environ.get("VLLM_SAMPLER_BACKEND")
    detail: dict[str, Any] = {
        "envAttentionBackend": env_attn,
        "flashinferEnvHint": bool(env_attn and "FLASH" in env_attn.upper()),
    }
    name = "unknown"
    try:
        if llm is not None:
            engine = getattr(llm, "llm_engine", None) or getattr(llm, "engine", None)
            cfg = getattr(engine, "vllm_config", None) or getattr(llm, "llm_engine", None)
            text = str(type(cfg)) + " " + str(cfg)
            if "flashinfer" in text.lower() or "FlashInfer" in text:
                name = "flashinfer"
            elif "triton" in text.lower():
                name = "triton"
            else:
                name = "native_or_unspecified"
            detail["configType"] = type(cfg).__name__ if cfg is not None else None
    except Exception as exc:  # noqa: BLE001
        detail["probeError"] = f"{type(exc).__name__}: {exc}"
        name = "probe_failed"
    if env_attn and "FLASHINFER" in env_attn.upper():
        name = "flashinfer"
    return {"samplerImplementation": name, "detail": detail}


def load_vllm_engine(
    pin: dict[str, Any],
    *,
    max_model_len: int | None = None,
    enable_lora: bool = False,
    max_lora_rank: int = 64,
) -> tuple[Any, dict[str, Any]]:
    """Load one vLLM engine; returns (llm, load_timing_meta)."""
    from vllm import LLM

    t0 = time.time()
    kwargs: dict[str, Any] = {
        "model": pin["modelId"],
        "tokenizer": pin["tokenizerId"],
        "revision": pin["modelRevision"],
        "tokenizer_revision": pin["tokenizerRevision"],
        "trust_remote_code": True,
        "dtype": "bfloat16",
    }
    if max_model_len is not None:
        kwargs["max_model_len"] = int(max_model_len)
    if enable_lora:
        kwargs["enable_lora"] = True
        kwargs["max_lora_rank"] = int(max_lora_rank)
    llm = LLM(**kwargs)
    load_ms = int((time.time() - t0) * 1000)
    # Optional short warmup (single empty-ish generate skipped — record slot only)
    warmup_ms = 0
    sampler = detect_sampler_implementation(llm)
    return llm, {
        "engineStartupMs": load_ms,
        "warmupMs": warmup_ms,
        "enableLora": bool(enable_lora),
        **sampler,
    }


def _build_lora_request(adapter_path: str | None) -> Any | None:
    if not adapter_path:
        return None
    from vllm.lora.request import LoRARequest

    return LoRARequest("c18d1-adapter", 1, str(adapter_path))


def generate_texts_vllm(
    *,
    llm: Any,
    prompts: list[str],
    fields: dict[str, Any],
    base_seed: int,
    item_indices: list[int],
    sample_index: int,
    adapter_path: str | None = None,
) -> list[dict[str, Any]]:
    """Submit **all** prompts in one ``generate()`` with per-request seeds."""
    from vllm import SamplingParams

    if len(prompts) != len(item_indices):
        raise ValueError("prompts and item_indices length mismatch")

    seeds = [sampling_seed_schedule(base_seed, idx, sample_index) for idx in item_indices]
    params_list = [
        SamplingParams(**sampling_params_kwargs(fields, seed=seed)) for seed in seeds
    ]
    lora_req = _build_lora_request(adapter_path)

    t0 = time.time()
    # vLLM accepts a list of SamplingParams matching prompts (per-request seeds).
    if lora_req is not None:
        outputs = llm.generate(prompts, params_list, lora_request=lora_req)
    else:
        outputs = llm.generate(prompts, params_list)
    batch_ms = (time.time() - t0) * 1000.0

    results: list[dict[str, Any]] = []
    for out, seed in zip(outputs, seeds):
        completion = out.outputs[0]
        finish = getattr(completion, "finish_reason", None)
        n_tokens = len(completion.token_ids or [])
        truncated = finish == "length" or n_tokens >= int(fields["maxNewTokens"])
        results.append(
            {
                "text": completion.text,
                "generatedTokens": n_tokens,
                "finishReason": finish,
                "samplingSeed": int(seed),
                "truncated": bool(truncated),
                "runtimeMs": batch_ms / max(len(prompts), 1),
                "batchSubmit": True,
                "adapterPath": adapter_path,
            },
        )
    return results


def build_request_manifest(
    *,
    items: list[dict[str, Any]],
    prompts: list[str],
    fields: dict[str, Any],
    base_seed: int,
    sample_index: int,
    item_indices: list[int] | None = None,
) -> dict[str, Any]:
    """Record prompt rendering, order, and per-request seeds for a condition."""
    indices = item_indices if item_indices is not None else list(range(len(items)))
    requests = []
    for pos, (item, prompt, idx) in enumerate(zip(items, prompts, indices)):
        seed = sampling_seed_schedule(base_seed, idx, sample_index)
        requests.append(
            {
                "position": pos,
                "itemId": item["id"],
                "itemIndex": idx,
                "sampleIndex": sample_index,
                "samplingSeed": seed,
                "promptCharLength": len(prompt),
                "promptSha256Prefix": __import__("hashlib").sha256(prompt.encode()).hexdigest()[:16],
            },
        )
    return {
        "batchSubmit": True,
        "requestCount": len(requests),
        "sampleIndex": sample_index,
        "enableThinking": bool(fields.get("enableThinking")),
        "doSample": bool(fields.get("doSample")),
        "maxNewTokens": int(fields["maxNewTokens"]),
        "requests": requests,
    }
