"""Runtime check of the installed MLX-LM loss mask. No optimizer steps."""

from __future__ import annotations

import hashlib
import importlib.metadata as metadata
import json
import sys
from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx_lm.tuner.trainer import default_loss, iterate_batches

ROOT = Path(__file__).resolve().parents[2]
CHECKPOINT = ROOT / "services/training/checkpoints/Qwen3-1.7B-MLX-4bit"
TRAINER = Path(sys.modules["mlx_lm.tuner.trainer"].__file__ or "")
OUT = ROOT / "services/training/results/m75c/phase1a/mask-audit.json"


class Stub:
    def __call__(self, inputs):
        return mx.zeros((inputs.shape[0], inputs.shape[1], 151936))


class PairDataset:
    def __init__(self, rows: list[tuple[list[int], int]]) -> None:
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        return self.rows[index]


def render(tokenizer, user: str) -> str:
    base = tokenizer.apply_chat_template([{"role": "user", "content": user}], add_generation_prompt=True, tokenize=False)
    return str(base) + "<think>\n\n</think>\n\n"


def encode_example(tokenizer, user: str, assistant: str) -> tuple[list[int], int]:
    prompt = render(tokenizer, user)
    eos = tokenizer.eos_token or ""
    prompt_ids = list(tokenizer.encode(prompt, add_special_tokens=False))
    full_ids = list(tokenizer.encode(prompt + assistant + eos, add_special_tokens=False))
    if full_ids[: len(prompt_ids)] != prompt_ids:
        raise SystemExit("prompt tokens are not a prefix of the full example")
    return full_ids, len(prompt_ids)


def batch_for(rows: list[tuple[list[int], int]], max_seq: int):
    first = next(iterate_batches(PairDataset(rows), batch_size=len(rows), max_seq_length=max_seq, loop=False, seed=0))
    return first


def describe(batch, lengths, tokenizer) -> dict:
    array = np.array(batch)
    bounds = np.array(lengths)
    target_width = array.shape[1] - 1
    steps = np.arange(1, target_width + 1)
    installed = (steps >= bounds[:, 0:1]) & (steps <= bounds[:, 1:])
    corrected = (steps >= bounds[:, 0:1]) & (steps < bounds[:, 1:])
    _loss, ntoks = default_loss(Stub(), mx.array(array), mx.array(bounds))
    mx.eval(ntoks)
    rows = []
    for row in range(array.shape[0]):
        token_count = int(bounds[row, 1])
        offset = int(bounds[row, 0])
        positions = []
        for index, step in enumerate(steps.tolist()):
            if not (installed[row, index] or corrected[row, index]):
                continue
            token_id = int(array[row, step])
            positions.append(
                {
                    "step": int(step),
                    "tokenIndex": int(step),
                    "tokenId": token_id,
                    "token": tokenizer.decode([token_id]),
                    "installed": bool(installed[row, index]),
                    "corrected": bool(corrected[row, index]),
                    "isPadding": step >= token_count,
                }
            )
        rows.append(
            {
                "offset": offset,
                "tokenCount": token_count,
                "paddedWidth": int(array.shape[1]),
                "targetWidth": int(target_width),
                "inputIds": array[row, :-1].astype(int).tolist(),
                "shiftedTargetIds": array[row, 1:].astype(int).tolist(),
                "paddingIndices": [index for index, token in enumerate(array[row].tolist()) if index >= token_count],
                "installedCount": int(installed[row].sum()),
                "correctedCount": int(corrected[row].sum()),
                "lossPositions": positions,
            }
        )
    return {"installedNtoks": int(np.array(ntoks).item()), "rows": rows}


def main() -> None:
    from mlx_lm import load

    model, tokenizer = load(str(CHECKPOINT), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
    del model
    user = "Compute the value of the expression. Reply with the integer result only.\nExpression: 19 * 16 * 2"
    tokens, offset = encode_example(tokenizer, user, "608")
    historical = describe(*batch_for([(tokens, offset)], 192), tokenizer)
    short_tokens = tokens[:12]
    long_tokens = tokens + [11, 12, 13, 14, 15]
    mixed = describe(*batch_for([(short_tokens, 8), (long_tokens, offset)], 192), tokenizer)
    filled = tokens + [7] * (192 - len(tokens))
    filled_batch = describe(*batch_for([(filled, 190)], 192), tokenizer)
    payload = {
        "mlxLmVersion": metadata.version("mlx-lm"),
        "mlxVersion": metadata.version("mlx"),
        "trainerSha256": hashlib.sha256(TRAINER.read_bytes()).hexdigest(),
        "trainerPath": str(TRAINER),
        "padTokenId": 0,
        "padTokenText": tokenizer.decode([0]),
        "eosTokenId": tokenizer.eos_token_id,
        "historicalExample": {
            "user": user,
            "assistant": "608",
            "tokenIds": tokens,
            "offset": offset,
            "decodedLossPreview": tokenizer.decode(tokens[offset:]),
            "batch": historical,
        },
        "mixedLengths": mixed,
        "filledToMaxSequence": filled_batch,
        "upperBoundExpression": "steps < lengths[:, 1:]",
        "upperBoundAloneIsComplete": False,
        "upperBoundReplacesLessOrEqual": True,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    row = historical["rows"][0]
    print(f"installed {row['installedCount']} corrected {row['correctedCount']} ntoks {historical['installedNtoks']}")


if __name__ == "__main__":
    main()
