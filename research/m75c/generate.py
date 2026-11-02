"""Greedy diagnostic generation. This script does not train or write adapters."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import mlx.core as mx
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CHECKPOINT = ROOT / "services/training/checkpoints/Qwen3-1.7B-MLX-4bit"
OUT = ROOT / "services/training/results/m75c/phase1a/generations"
PROMPT_B = "Solve the arithmetic expression accurately. You may show intermediate calculations. End your response with `Final answer: <integer>`.\nExpression: "

MODELS = [
    ("base", None, None),
    ("self-101-r1", ROOT / "services/training/research-artifacts/runs/self-101-r1", ROOT / "services/training/results/m75/training/self-101-r1.json"),
    ("supervised-101", ROOT / "services/training/research-artifacts/runs/supervised-101", ROOT / "services/training/results/m75/training/supervised-101.json"),
    ("self-202-r1", ROOT / "services/training/research-artifacts/runs/self-202-r1", ROOT / "services/training/results/m75/training/self-202-r1.json"),
    ("supervised-202", ROOT / "services/training/research-artifacts/runs/supervised-202", ROOT / "services/training/results/m75/training/supervised-202.json"),
    ("self-303-r1", ROOT / "services/training/research-artifacts/runs/self-303-r1", ROOT / "services/training/results/m75/training/self-303-r1.json"),
    ("supervised-303", ROOT / "services/training/research-artifacts/runs/supervised-303", ROOT / "services/training/results/m75/training/supervised-303.json"),
    ("structured-s5-n25", ROOT / "services/training/research-artifacts/m75b/runs/structured-s5-n25", ROOT / "services/training/results/m75b/training/structured-s5-n25.json"),
    ("structured-s5-n25-seed-202", ROOT / "services/training/research-artifacts/m75b/runs/structured-s5-n25-seed-202", ROOT / "services/training/results/m75b/training/structured-s5-n25-seed-202.json"),
    ("structured-s5-n25-seed-303", ROOT / "services/training/research-artifacts/m75b/runs/structured-s5-n25-seed-303", ROOT / "services/training/results/m75b/training/structured-s5-n25-seed-303.json"),
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def render(tokenizer, user: str) -> str:
    base = tokenizer.apply_chat_template([{"role": "user", "content": user}], add_generation_prompt=True, tokenize=False)
    return str(base) + "<think>\n\n</think>\n\n"


def prompt_b(prompt: str) -> str:
    marker = "\nExpression: "
    index = prompt.rfind(marker)
    if index < 0:
        raise SystemExit("prompt has no expression")
    return PROMPT_B + prompt[index + len(marker) :].strip()


def done_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {json.loads(line)["itemId"] for line in path.read_text().splitlines() if line.strip()}


def generate_one(model, tokenizer, user: str, max_tokens: int) -> tuple[str, int, str]:
    from mlx_lm import stream_generate
    from mlx_lm.sample_utils import make_sampler

    mx.random.seed(0)
    np.random.seed(0)
    prompt = render(tokenizer, user)
    text = ""
    last = None
    for response in stream_generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens, sampler=make_sampler(temp=0.0, top_p=1.0)):
        text += response.text
        last = response
    if last is None:
        return "", 0, "empty"
    return text, int(last.generation_tokens), str(last.finish_reason)


def run_condition(model, tokenizer, items: list[dict], output: Path, condition: str, max_tokens: int, prompt_name: str, historical: dict[str, str], limit: int | None) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    finished = done_ids(output)
    written = 0
    with output.open("a") as handle:
        for row in items:
            if row["itemId"] in finished:
                continue
            if limit is not None and written >= limit:
                break
            user = row["prompt"] if prompt_name == "a" else prompt_b(row["prompt"])
            text, tokens, reason = generate_one(model, tokenizer, user, max_tokens)
            payload = {
                "model": output.parent.name,
                "condition": condition,
                "promptName": prompt_name,
                "maxTokens": max_tokens,
                "itemId": row["itemId"],
                "prompt": user,
                "response": text,
                "expectedAnswer": row["expectedAnswer"],
                "historicalResponse": historical.get(row["itemId"]),
                "finishReason": reason,
                "completionTokens": tokens,
                "truncated": reason == "length",
                "seed": 0,
                "temperature": 0,
                "topP": 1,
                "thinking": "closed-empty-prefill",
            }
            handle.write(json.dumps(payload) + "\n")
            handle.flush()
            written += 1


def historical_map(path: Path | None) -> dict[str, str]:
    if path is None or not path.exists():
        return {}
    return {row["itemId"]: row["response"] for row in read_jsonl(path)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--models", default="all")
    args = parser.parse_args()
    from mlx_lm import load

    selected = {name.strip() for name in args.models.split(",")} if args.models != "all" else None
    limit = args.limit or None
    sealed = read_jsonl(ROOT / "services/training/results/m75/evals/baseline-sealed.jsonl")
    development = read_jsonl(ROOT / "services/training/results/m75/evals/baseline-dev.jsonl")
    for name, adapter, meta in MODELS:
        if selected is not None and name not in selected:
            continue
        expected = None
        if meta is not None:
            record = json.loads(meta.read_text())
            expected = record["sha256"]
            actual = sha256_file(Path(adapter) / "adapters.safetensors")
            if actual != expected:
                raise SystemExit(f"{name} adapter hash {actual} does not match the stored hash {expected}")
        folder = OUT / name
        repro_items = sealed
        repro_history = historical_map(ROOT / "services/training/results/m75/evals" / ("baseline-sealed.jsonl" if name == "base" else f"{name}-sealed.jsonl"))
        if name.startswith("structured-"):
            repro_items = read_jsonl(ROOT / "services/training/results/m75b/evals" / ("baseline-sealed.jsonl" if name == "base" else f"{name}-sealed.jsonl"))
            repro_history = historical_map(ROOT / "services/training/results/m75b/evals" / f"{name}-sealed.jsonl")
        print(f"loading {name}", flush=True)
        kwargs = {"tokenizer_config": {"trust_remote_code": False}, "trust_remote_code": False}
        if adapter is not None:
            model, tokenizer = load(str(CHECKPOINT), adapter_path=str(adapter), **kwargs)
        else:
            model, tokenizer = load(str(CHECKPOINT), **kwargs)
        run_condition(model, tokenizer, repro_items, folder / "repro-a.jsonl", "repro-a", 32, "a", repro_history, limit)
        run_condition(model, tokenizer, sealed, folder / "sealed-a.jsonl", "sealed-a", 128, "a", historical_map(ROOT / "services/training/results/m75/evals" / ("baseline-sealed.jsonl" if name == "base" else f"{name}-sealed.jsonl")), limit)
        run_condition(model, tokenizer, sealed, folder / "sealed-b.jsonl", "sealed-b", 128, "b", {}, limit)
        run_condition(model, tokenizer, development, folder / "dev-a.jsonl", "dev-a", 128, "a", historical_map(ROOT / "services/training/results/m75/evals" / ("baseline-dev.jsonl" if name == "base" else f"{name}-dev.jsonl")), limit)
        run_condition(model, tokenizer, development, folder / "dev-b.jsonl", "dev-b", 128, "b", {}, limit)
        del model
        if hasattr(mx, "metal") and hasattr(mx.metal, "clear_cache"):
            mx.metal.clear_cache()
        print(f"finished {name}", flush=True)


if __name__ == "__main__":
    main()
