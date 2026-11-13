#!/usr/bin/env python3
"""Generation helpers for C1.8D.1 — slicing, seeding, Transformers 5.23 compat.

These functions are unit-tested without a GPU. Batched eval imports them.
"""

from __future__ import annotations

from typing import Any

EVAL_IMPLEMENTATION_VERSION = "c18d1-batched-eval-v4"
PROMPT_INSTRUCTION_VERSION = "c18d1-answer-instruction-v2"

# Official evals fix batch size and item composition; base vs adapter must share them.
# Greedy wording can change with batch shape (bf16 near-tie flips) even when graded
# outcomes agree — see batch-invariance gate v3 (v2 preserved as historical evidence).
BATCHING_POLICY = {
    "batchSizeFixedPerEvalConfig": True,
    "batchCompositionFixedPerEvalConfig": True,
    "baseAndAdapterIdenticalBatching": True,
    "fixedItemOrder": True,
    "fixedPrompts": True,
    "fixedGrader": True,
    "fixedDecoding": True,
    "fixedModelRevision": True,
    "batchInvarianceGateVersion": "c18d1-batch-invariance-v3",
    "note": (
        "Batch size and batch composition are fixed per evaluation configuration. "
        "Base and adapter are always evaluated with identical batching, because "
        "batch shape can change greedy wording under bf16. Item order, prompts, "
        "grader, decoding, and model revision are also fixed for a given eval config."
    ),
}

# Exact final-answer contract appended to each item prompt (questions unchanged).
FINAL_ANSWER_INSTRUCTION = (
    "Put the final result on its own standalone line in exactly this format "
    "(no wrappers, no boxing):\n"
    "ANSWER: <mathematical expression>"
)


def assert_left_padding(tokenizer: Any) -> None:
    side = getattr(tokenizer, "padding_side", None)
    if side != "left":
        raise ValueError(
            f"C1.8D.1 batched eval requires tokenizer.padding_side='left' (got {side!r})",
        )


def prompt_token_length(input_ids_row_len: int) -> int:
    """Return the prompt length used to slice newly generated tokens.

    With left padding, every row in a padded batch shares the same
    ``input_ids.shape[1]``. Do **not** use ``attention_mask.sum()`` — that is
    the unpadded token count and slices into the prompt suffix for shorter rows.
    """
    return int(input_ids_row_len)


def slice_new_token_ids(generated_row: Any, prompt_len: int) -> Any:
    """Return only newly generated token ids for one sequence row."""
    return generated_row[int(prompt_len) :]


def build_generate_kwargs(
    *,
    fields: dict[str, Any],
    pad_token_id: int | None,
    eos_token_id: int | None,
) -> dict[str, Any]:
    """Build ``model.generate`` kwargs compatible with Transformers 5.23+.

    Never passes ``generator=`` — rejected by Transformers 5.23.0 as an unused
    model kwarg. Sampling seeds are applied via ``apply_sampling_seed`` instead.
    """
    kwargs: dict[str, Any] = {
        "max_new_tokens": int(fields["maxNewTokens"]),
        "pad_token_id": pad_token_id,
        "eos_token_id": eos_token_id,
        "do_sample": bool(fields["doSample"]),
    }
    if fields["doSample"]:
        kwargs["temperature"] = float(fields["temperature"])
        if fields.get("topP") is not None:
            kwargs["top_p"] = float(fields["topP"])
        if fields.get("topK") is not None:
            kwargs["top_k"] = int(fields["topK"])
        if fields.get("repetitionPenalty") is not None:
            kwargs["repetition_penalty"] = float(fields["repetitionPenalty"])
    return kwargs


def apply_sampling_seed(torch_mod: Any, seed: int, *, device: str) -> dict[str, Any]:
    """Seed PyTorch RNG for the next ``generate`` call.

    Transformers 5.23 does not accept ``generator`` on ``model.generate``.
    We seed the global CPU (and CUDA) RNG instead. When multiple sequences are
    generated in one batched sampling call, they share this RNG stream — order
    and batch composition can affect draws. Prefer per-item generate when
    ``do_sample`` is True (see batched_eval).
    """
    torch_mod.manual_seed(int(seed))
    if device == "cuda" and hasattr(torch_mod, "cuda") and torch_mod.cuda.is_available():
        torch_mod.cuda.manual_seed_all(int(seed))
    return {
        "seedApplied": int(seed),
        "method": "torch.manual_seed[+cuda.manual_seed_all]",
        "generatorKwargUsed": False,
        "note": (
            "Per-item generate used for sampling isolation when do_sample=True. "
            "Greedy batched generate has no sampling RNG dependence."
        ),
    }


def filter_unsupported_generate_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Drop known-unsupported generate kwargs (defense in depth)."""
    banned = {"generator"}
    return {key: value for key, value in kwargs.items() if key not in banned}
