#!/usr/bin/env python3
"""Chat-template helpers for C1.8D PEFT LoRA (prompt masking + thinking modes)."""

from __future__ import annotations

import hashlib
from typing import Any


def template_fingerprint(tokenizer: Any) -> str:
    raw = str(getattr(tokenizer, "chat_template", "") or "")
    return hashlib.sha256(raw.encode()).hexdigest()


def build_chat_texts(
    tokenizer: Any,
    user: str,
    assistant: str | None,
    *,
    enable_thinking: bool,
) -> tuple[str, str]:
    """Return (prompt_only_text, full_text_with_assistant).

    Training and evaluation must pass the same enable_thinking value.
    For supervised fine-tuning on final answers, use enable_thinking=False.
    """
    user_messages = [{"role": "user", "content": user}]
    kwargs: dict[str, Any] = {
        "tokenize": False,
        "add_generation_prompt": True,
    }
    # Qwen3 chat templates accept enable_thinking; ignore if unsupported.
    try:
        prompt = tokenizer.apply_chat_template(
            user_messages,
            enable_thinking=enable_thinking,
            **kwargs,
        )
    except TypeError:
        prompt = tokenizer.apply_chat_template(user_messages, **kwargs)

    if assistant is None:
        return str(prompt), str(prompt)

    full_kwargs = {
        "tokenize": False,
        "add_generation_prompt": False,
    }
    messages = [
        *user_messages,
        {"role": "assistant", "content": assistant},
    ]
    try:
        full = tokenizer.apply_chat_template(
            messages,
            enable_thinking=enable_thinking,
            **full_kwargs,
        )
    except TypeError:
        full = tokenizer.apply_chat_template(messages, **full_kwargs)
    return str(prompt), str(full)


def tokenize_with_prompt_mask(
    tokenizer: Any,
    user: str,
    assistant: str,
    max_length: int,
    *,
    enable_thinking: bool = False,
) -> dict[str, Any]:
    prompt_text, full_text = build_chat_texts(
        tokenizer,
        user,
        assistant,
        enable_thinking=enable_thinking,
    )
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
    full = tokenizer(
        full_text,
        add_special_tokens=False,
        truncation=True,
        max_length=max_length,
    )
    input_ids: list[int] = list(full["input_ids"])
    eos = tokenizer.eos_token_id
    if eos is not None and (len(input_ids) == 0 or input_ids[-1] != eos):
        if len(input_ids) < max_length:
            input_ids.append(int(eos))
    labels = list(input_ids)
    prompt_len = min(len(prompt_ids), len(labels))
    for index in range(prompt_len):
        labels[index] = -100
    return {
        "input_ids": input_ids,
        "attention_mask": [1] * len(input_ids),
        "labels": labels,
        "prompt_token_count": prompt_len,
        "label_token_count": sum(1 for value in labels if value != -100),
        "enableThinking": enable_thinking,
        "templateFingerprint": template_fingerprint(tokenizer),
    }
