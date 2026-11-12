#!/usr/bin/env python3
"""Chat-template helpers for C1.8D PEFT LoRA (prompt masking + EOS)."""

from __future__ import annotations

from typing import Any


def build_chat_texts(tokenizer: Any, user: str, assistant: str | None) -> tuple[str, str]:
    """Return (prompt_only_text, full_text_with_assistant).

    Uses the tokenizer chat template when available. Prompt-only excludes the
    assistant turn so labels can mask prompt tokens with -100.
    """
    user_messages = [{"role": "user", "content": user}]
    if hasattr(tokenizer, "apply_chat_template"):
        prompt = tokenizer.apply_chat_template(
            user_messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        if assistant is None:
            return str(prompt), str(prompt)
        full = tokenizer.apply_chat_template(
            [
                *user_messages,
                {"role": "assistant", "content": assistant},
            ],
            tokenize=False,
            add_generation_prompt=False,
        )
        return str(prompt), str(full)

    # Fallback for tokenizers without a chat template (should not happen for Qwen3).
    prompt = f"User: {user}\nAssistant:"
    if assistant is None:
        return prompt, prompt
    return prompt, f"{prompt} {assistant}"


def tokenize_with_prompt_mask(
    tokenizer: Any,
    user: str,
    assistant: str,
    max_length: int,
) -> dict[str, list[int]]:
    prompt_text, full_text = build_chat_texts(tokenizer, user, assistant)
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
    full = tokenizer(
        full_text,
        add_special_tokens=False,
        truncation=True,
        max_length=max_length,
    )
    input_ids: list[int] = list(full["input_ids"])
    # Ensure EOS on the assistant completion when the tokenizer defines one.
    eos = tokenizer.eos_token_id
    if eos is not None and (len(input_ids) == 0 or input_ids[-1] != eos):
        if len(input_ids) < max_length:
            input_ids.append(int(eos))
    labels = list(input_ids)
    prompt_len = min(len(prompt_ids), len(labels))
    for index in range(prompt_len):
        labels[index] = -100
    attention_mask = [1] * len(input_ids)
    return {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "labels": labels,
        "prompt_token_count": prompt_len,
        "label_token_count": sum(1 for value in labels if value != -100),
    }
