#!/usr/bin/env python3
"""Experimental vLLM generation backend for C1.8D.1 benchmarks.

Not the official evaluation backend. Continuous batching varies batch
composition, so vLLM is ineligible as official unless same-config
repeatability passes under backend=vllm.
"""

from __future__ import annotations

from typing import Any

from decoding import sampling_seed_schedule
from generation_utils import FINAL_ANSWER_INSTRUCTION


BACKEND_ID = "vllm"
BACKEND_STATUS = "experimental"


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
        if seed is not None:
            kwargs["seed"] = int(seed)
    else:
        kwargs["temperature"] = 0.0
        # Greedy; seed optional for reproducibility hooks
        if seed is not None:
            kwargs["seed"] = int(seed)
    return kwargs


def load_vllm_engine(pin: dict[str, Any], *, max_model_len: int | None = None) -> Any:
    from vllm import LLM

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
    return LLM(**kwargs)


def generate_texts_vllm(
    *,
    llm: Any,
    prompts: list[str],
    fields: dict[str, Any],
    base_seed: int,
    item_indices: list[int],
    sample_index: int,
) -> list[dict[str, Any]]:
    """Generate one sample for each prompt; return text + token metadata."""
    from vllm import SamplingParams

    results: list[dict[str, Any]] = []
    if fields.get("doSample"):
        # Per-request seeds for sampled isolation
        for prompt, item_index in zip(prompts, item_indices):
            seed = sampling_seed_schedule(base_seed, item_index, sample_index)
            params = SamplingParams(**sampling_params_kwargs(fields, seed=seed))
            outputs = llm.generate([prompt], params)
            out = outputs[0]
            completion = out.outputs[0]
            results.append(
                {
                    "text": completion.text,
                    "generatedTokens": len(completion.token_ids or []),
                    "finishReason": getattr(completion, "finish_reason", None),
                    "samplingSeed": seed,
                },
            )
    else:
        params = SamplingParams(**sampling_params_kwargs(fields, seed=base_seed))
        outputs = llm.generate(prompts, params)
        for out in outputs:
            completion = out.outputs[0]
            results.append(
                {
                    "text": completion.text,
                    "generatedTokens": len(completion.token_ids or []),
                    "finishReason": getattr(completion, "finish_reason", None),
                    "samplingSeed": base_seed,
                },
            )
    return results
