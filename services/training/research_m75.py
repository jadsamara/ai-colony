#!/usr/bin/env python3
"""Standalone M7.5 worker for Qwen3 arithmetic LoRA.

This process is not the colony Gemma trainer. It refuses every profile except
qwen3-1.7b-arith-m75, refuses the Gemma artifact root, and never merges an
adapter back into the base checkpoint.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CHECKPOINTS = (ROOT / "checkpoints").resolve()
ARTIFACTS = (ROOT / "research-artifacts").resolve()
PROFILE = "qwen3-1.7b-arith-m75"
ALLOWED_MODELS = {
    "Qwen3-1.7B-MLX-4bit": "Qwen/Qwen3-1.7B-MLX-4bit",
    "Qwen3-0.6B-4bit": "mlx-community/Qwen3-0.6B-4bit",
}
THINK_PREFIX = "<think>\n\n</think>\n\n"
FORBIDDEN_NAMES = {"test.jsonl", "sealed.jsonl", "holdout.jsonl"}


class WorkerError(Exception):
    pass


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root)
        return True
    except ValueError:
        return False


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def base_weight_hash(model_dir: Path) -> str:
    files = sorted(path for path in model_dir.glob("*.safetensors") if path.is_file() and "adapter" not in path.name)
    if not files:
        raise WorkerError("base checkpoint has no safetensors weights")
    return hashlib.sha256("".join(f"{path.name}:{sha256_file(path)}" for path in files).encode()).hexdigest()


def load_job(argv: list[str]) -> dict:
    if len(argv) != 3 or argv[1] != "--job":
        raise WorkerError("usage: research_m75.py --job <path>")
    path = Path(argv[2]).resolve()
    if not inside(path, ARTIFACTS):
        raise WorkerError("job path escapes the research artifact root")
    job = json.loads(path.read_text())
    if job.get("profile") != PROFILE or job.get("family") != "qwen3":
        raise WorkerError("job is outside the Qwen3 research allowlist")
    if "gemma" in json.dumps(job).lower():
        raise WorkerError("the research worker cannot target Gemma")
    command = job.get("command")
    if command not in {"validate", "probe", "generate", "train", "init", "audit"}:
        raise WorkerError("command is not allowlisted")
    model_dir = Path(str(job.get("modelPath", ""))).resolve()
    if not inside(model_dir, CHECKPOINTS) or model_dir.name not in ALLOWED_MODELS:
        raise WorkerError("checkpoint is not an allowlisted Qwen3 research model")
    if job.get("modelId") != ALLOWED_MODELS[model_dir.name]:
        raise WorkerError("model id does not match the checkpoint directory")
    if command == "train":
        assert_train_job(job)
    if command == "generate":
        assert_generate_job(job)
    if command == "probe":
        assert_probe_job(job)
    if command in {"init", "audit"}:
        output = Path(str(job.get("outputDir", job.get("outputPath", "")))).resolve()
        if not inside(output, ARTIFACTS):
            raise WorkerError("research output escapes the artifact root")
    return job


def assert_range(name: str, value: object, low: float, high: float) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= float(value) <= high:
        raise WorkerError(f"{name} is outside the research budget")


def assert_train_job(job: dict) -> None:
    assert_range("steps", job.get("steps"), 1, 200)
    assert_range("rank", job.get("rank"), 1, 16)
    assert_range("maxSeq", job.get("maxSeq"), 32, 512)
    assert_range("batchSize", job.get("batchSize"), 1, 2)
    assert_range("numLayers", job.get("numLayers"), 1, 28)
    assert_range("gradAccum", job.get("gradAccum"), 1, 8)
    assert_range("learningRate", job.get("learningRate"), 1e-6, 1e-3)
    assert_range("seed", job.get("seed"), 0, 2_147_483_647)
    if job.get("targetModules") != ["q_proj", "v_proj"]:
        raise WorkerError("target modules are not allowlisted")
    if job.get("dropout") != 0 or float(job.get("scale", -1)) != 2.0:
        raise WorkerError("dropout or scale is not the frozen research value")
    data = Path(str(job.get("dataDir", ""))).resolve()
    output = Path(str(job.get("outputDir", ""))).resolve()
    forbidden = Path(str(job.get("forbiddenCanonicalsPath", ""))).resolve()
    if not inside(data, ARTIFACTS) or not inside(output, ARTIFACTS) or not inside(forbidden, ARTIFACTS):
        raise WorkerError("training paths escape the research artifact root")
    names = {path.name for path in data.iterdir()} if data.is_dir() else set()
    if names & FORBIDDEN_NAMES or not {"train.jsonl", "valid.jsonl"}.issubset(names):
        raise WorkerError("training data must contain only train and valid splits")
    if (data / "test.jsonl").exists():
        raise WorkerError("the held-out test split must not be visible to training")
    blocked = {line.strip() for line in forbidden.read_text().splitlines() if line.strip()}
    if not blocked:
        raise WorkerError("the forbidden-expression list is empty")
    for name in ("train.jsonl", "valid.jsonl"):
        for line in (data / name).read_text().splitlines():
            if not line.strip():
                continue
            payload = json.loads(line)
            message = payload["messages"][0]["content"]
            canonical = expression_of(message)
            if canonical in blocked:
                raise WorkerError("training data contains a forbidden held-out expression")


def assert_generate_job(job: dict) -> None:
    items = job.get("items")
    if not isinstance(items, list) or not items or len(items) > 400:
        raise WorkerError("generate items must be a non-empty list of at most 400")
    assert_range("temperature", job.get("temperature"), 0, 1)
    assert_range("maxTokens", job.get("maxTokens"), 1, 128)
    if job.get("thinking") != "closed-empty-prefill":
        raise WorkerError("thinking mode is not the frozen research setting")
    adapter = job.get("adapterPath")
    if adapter:
        adapter_dir = Path(str(adapter)).resolve()
        if not inside(adapter_dir, ARTIFACTS):
            raise WorkerError("adapter path escapes the research artifact root")
    output = Path(str(job.get("outputPath", ""))).resolve()
    if not inside(output, ARTIFACTS):
        raise WorkerError("prediction output escapes the research artifact root")


def assert_probe_job(job: dict) -> None:
    examples = job.get("probeExamples")
    if not isinstance(examples, list) or len(examples) != 1:
        raise WorkerError("probe requires one out-of-range example")
    example = examples[0]
    canonical = expression_of(str(example.get("user", "")))
    numbers = [int(part) for part in canonical.replace("+", " ").replace("-", " ").replace("*", " ").split()]
    if not numbers or max(numbers) < 100_000:
        raise WorkerError("probe expression must stay outside the experiment operand range")
    output = Path(str(job.get("outputDir", ""))).resolve()
    if not inside(output, ARTIFACTS):
        raise WorkerError("probe output escapes the research artifact root")


def expression_of(content: str) -> str:
    marker = "\nExpression: "
    index = content.rfind(marker)
    if index < 0:
        raise WorkerError("prompt has no expression")
    return content[index + len(marker) :].strip()


def render_prompt(tokenizer, user: str) -> str:
    base = tokenizer.apply_chat_template(
        [{"role": "user", "content": user}],
        add_generation_prompt=True,
        tokenize=False,
    )
    return str(base) + THINK_PREFIX


def eval_expr(canonical: str) -> int:
    parts = canonical.split()
    values = []
    operators = []
    expect_value = True
    for part in parts:
        if expect_value:
            if not part.lstrip("-").isdigit():
                raise WorkerError("structured step is not an arithmetic expression")
            values.append(int(part))
            expect_value = False
        else:
            if part not in {"+", "-", "*"}:
                raise WorkerError("structured step is not an arithmetic expression")
            operators.append(part)
            expect_value = True
    if expect_value or not values:
        raise WorkerError("structured step is incomplete")
    terms = []
    additive = []
    current = values[0]
    for operator, value in zip(operators, values[1:], strict=True):
        if operator == "*":
            current *= value
        else:
            terms.append(current)
            additive.append(operator)
            current = value
    terms.append(current)
    result = terms[0]
    for operator, term in zip(additive, terms[1:], strict=True):
        result = result + term if operator == "+" else result - term
    return result


def verify_structured(text: str, expected: int) -> None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        raise WorkerError("structured target is empty")
    for line in lines:
        if "=" not in line:
            raise WorkerError("structured target contains a line without an equation")
        left, right = line.rsplit("=", 1)
        if eval_expr(left.strip()) != int(right.strip()):
            raise WorkerError("structured step does not recompute")
    final = int(lines[-1].rsplit("=", 1)[1].strip())
    if final != expected:
        raise WorkerError("structured target does not match the verified answer")


class AnswerDataset:
    def __init__(self, rows: list[dict], tokenizer, mode: str = "answer") -> None:
        self._data = rows
        self.tokenizer = tokenizer
        self.mode = mode

    def __len__(self) -> int:
        return len(self._data)

    def __getitem__(self, index: int) -> dict:
        return self._data[index]

    def process(self, row: dict) -> tuple[list[int], int]:
        user = row["messages"][0]["content"]
        assistant = row["messages"][1]["content"]
        if self.mode == "structured":
            verify_structured(assistant, int(row["expected"]))
        elif not isinstance(assistant, str) or not assistant.lstrip("-").isdigit():
            raise WorkerError("training target must be a verified integer")
        prompt = render_prompt(self.tokenizer, user)
        eos = self.tokenizer.eos_token or ""
        prompt_ids = list(self.tokenizer.encode(prompt, add_special_tokens=False))
        full_ids = list(self.tokenizer.encode(prompt + assistant + eos, add_special_tokens=False))
        if full_ids[: len(prompt_ids)] != prompt_ids:
            raise WorkerError("answer tokens are not a suffix of the rendered prompt")
        return full_ids, len(prompt_ids)


def run_mlx(job: dict) -> None:
    import mlx.core as mx
    import numpy as np
    from mlx.utils import tree_flatten
    from mlx_lm import generate, load
    from mlx_lm.lora import train_model
    from mlx_lm.sample_utils import make_sampler
    from mlx_lm.tuner.callbacks import TrainingCallback

    model_dir = Path(job["modelPath"]).resolve()
    before = base_weight_hash(model_dir)
    started = time.perf_counter()
    if hasattr(mx, "reset_peak_memory"):
        mx.reset_peak_memory()

    if job["command"] == "audit":
        model, tokenizer = load(str(model_dir), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
        example = job["example"]
        mode = job.get("target", "answer")
        dataset = AnswerDataset([{"messages": [{"role": "user", "content": example["user"]}, {"role": "assistant", "content": example["assistant"]}], "expected": example.get("expected")}], tokenizer, mode)
        tokens, offset = dataset.process(dataset[0])
        prompt = render_prompt(tokenizer, example["user"])
        prompt_ids = list(tokenizer.encode(prompt, add_special_tokens=False))
        target = tokenizer.decode(tokens[offset:])
        destination = Path(job["outputPath"]).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps({
            "renderedPrompt": prompt,
            "promptTokenCount": len(prompt_ids),
            "fullTokenCount": len(tokens),
            "lossTokenCount": len(tokens) - offset,
            "offset": offset,
            "decodedLossSpan": target,
            "promptLeaksIntoLoss": "Expression" in target,
            "inferencePromptMatchesTrainingPrefix": tokens[: len(prompt_ids)] == prompt_ids,
            "lossTokenPreview": tokens[offset:offset + 16],
            "target": mode,
            "baseSha256": before,
        }))
        return

    if job["command"] == "init":
        from mlx_lm.tuner.utils import linear_to_lora_layers

        model, tokenizer = load(str(model_dir), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
        keys = projection_keys(model)
        model.freeze()
        linear_to_lora_layers(model, int(job["numLayers"]), {"rank": int(job["rank"]), "dropout": 0.0, "scale": 2.0, "keys": keys})
        output = Path(job["outputDir"]).resolve()
        output.mkdir(parents=True, exist_ok=True)
        weights = dict(tree_flatten(model.trainable_parameters()))
        artifact = output / "adapters.safetensors"
        mx.save_safetensors(str(artifact), weights)
        (output / "adapter_config.json").write_text(json.dumps({
            "fine_tune_type": "lora",
            "num_layers": int(job["numLayers"]),
            "lora_parameters": {"rank": int(job["rank"]), "dropout": 0.0, "scale": 2.0, "keys": keys},
            "model": str(model_dir),
            "adapter_path": str(output),
            "iters": 0,
        }))
        if base_weight_hash(model_dir) != before:
            raise WorkerError("base checkpoint changed while initializing an adapter")
        (output / "result.json").write_text(json.dumps({
            "cancelled": False,
            "artifactPath": str(artifact),
            "adapterSha256": sha256_file(artifact),
            "durationMs": int((time.perf_counter() - started) * 1000),
            "peakMemoryBytes": int(mx.get_peak_memory()) if hasattr(mx, "get_peak_memory") else None,
            "trainableParameters": int(sum(value.size for _name, value in tree_flatten(model.trainable_parameters()))),
            "trainableL2": adapter_l2(model),
            "baseSha256": before,
            "baseUnchanged": True,
            "steps": 0,
        }))
        return

    if job["command"] == "generate":
        adapter = job.get("adapterPath")
        if adapter:
            weights = Path(adapter).resolve() / "adapters.safetensors"
            if sha256_file(weights) != job.get("expectedAdapterSha256"):
                raise WorkerError("adapter checksum does not match the trained artifact")
            model, tokenizer = load(str(model_dir), adapter_path=str(weights.parent), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
            loaded_adapter = True
            adapter_sha = sha256_file(weights)
        else:
            model, tokenizer = load(str(model_dir), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
            loaded_adapter = False
            adapter_sha = None
        sampler = make_sampler(temp=float(job["temperature"]), top_p=float(job.get("topP", 1)))
        predictions = []
        for item in job["items"]:
            mx.random.seed(int(item["seed"]))
            np.random.seed(int(item["seed"]))
            prompt = render_prompt(tokenizer, str(item["prompt"]))
            tic = time.perf_counter()
            response = generate(model, tokenizer, prompt=prompt, max_tokens=int(job["maxTokens"]), sampler=sampler, verbose=False)
            elapsed = time.perf_counter() - tic
            predictions.append(
                {
                    "id": item["id"],
                    "attemptId": item.get("attemptId", "0"),
                    "response": response,
                    "seed": int(item["seed"]),
                    "latencyMs": int(elapsed * 1000),
                    "promptTokens": len(tokenizer.encode(prompt, add_special_tokens=False)),
                    "completionTokens": len(tokenizer.encode(response, add_special_tokens=False)),
                }
            )
        if base_weight_hash(model_dir) != before:
            raise WorkerError("base checkpoint changed during inference")
        destination = Path(job["outputPath"]).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            json.dumps(
                {
                    "predictions": predictions,
                    "loadedAdapter": loaded_adapter,
                    "adapterSha256": adapter_sha,
                    "baseSha256": before,
                    "peakMemoryBytes": int(mx.get_peak_memory()) if hasattr(mx, "get_peak_memory") else None,
                    "durationMs": int((time.perf_counter() - started) * 1000),
                    "thinking": THINK_PREFIX,
                }
            )
        )
        return

    if job["command"] == "probe":
        model, tokenizer = load(str(model_dir), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
        example = job["probeExamples"][0]
        from mlx_lm.sample_utils import make_sampler

        sample_prompt = render_prompt(tokenizer, example["user"])
        sample_response = generate(model, tokenizer, prompt=sample_prompt, max_tokens=32, sampler=make_sampler(temp=0.0), verbose=False)
        dataset = AnswerDataset([{"messages": [{"role": "user", "content": example["user"]}, {"role": "assistant", "content": example["assistant"]}]}], tokenizer)
        tokens, offset = dataset.process(dataset[0])
        target = tokenizer.decode(tokens[offset:])
        if example["assistant"] not in target or "Expression" in target:
            raise WorkerError("loss mask does not isolate the verified integer")
        keys = sorted({name for name, _module in model.layers[0].named_modules() if name.endswith("q_proj") or name.endswith("v_proj")})
        if "self_attn.q_proj" not in keys or "self_attn.v_proj" not in keys:
            raise WorkerError(f"allowlisted projections were not found: {keys}")
        output = Path(job["outputDir"]).resolve()
        output.mkdir(parents=True, exist_ok=True)
        data = output / "probe-data"
        data.mkdir(parents=True, exist_ok=True)
        row = json.dumps({"messages": [{"role": "user", "content": example["user"]}, {"role": "assistant", "content": example["assistant"]}]})
        (data / "train.jsonl").write_text(row + "\n")
        (data / "valid.jsonl").write_text(row + "\n")
        np.random.seed(0)
        args = train_args(job, data, output, keys, steps=1, seed=0)
        train_model(args, model, dataset, dataset, TrainingCallback())
        artifact = output / "adapters.safetensors"
        if not artifact.is_file():
            raise WorkerError("probe did not produce a LoRA adapter")
        if base_weight_hash(model_dir) != before:
            raise WorkerError("base checkpoint changed during the probe")
        config = json.loads((model_dir / "config.json").read_text())
        (output / "probe.json").write_text(
            json.dumps(
                {
                    "baseSha256": before,
                    "baseUnchanged": True,
                    "adapterSha256": sha256_file(artifact),
                    "maskedTarget": target,
                    "layers": len(model.layers),
                    "projections": keys,
                    "quantization": config.get("quantization"),
                    "modelType": config.get("model_type"),
                    "architectures": config.get("architectures"),
                    "vocabSize": config.get("vocab_size"),
                    "hiddenSize": config.get("hidden_size"),
                    "peakMemoryBytes": int(mx.get_peak_memory()) if hasattr(mx, "get_peak_memory") else None,
                    "durationMs": int((time.perf_counter() - started) * 1000),
                    "tokenizerSha256": sha256_file(model_dir / "tokenizer.json") if (model_dir / "tokenizer.json").is_file() else None,
                    "thinkingPrefix": THINK_PREFIX,
                    "renderedPrompt": render_prompt(tokenizer, example["user"]),
                    "sampleResponse": sample_response,
                }
            )
        )
        return

    class Capture(TrainingCallback):
        def __init__(self) -> None:
            self.metrics: list[dict] = []

        def on_train_loss_report(self, info: dict) -> None:
            self._cancel()
            self.metrics.append({"step": int(info["iteration"]), "trainLoss": float(info["train_loss"]), "validationLoss": None, "learningRate": float(info["learning_rate"]), "trainedTokens": float(info.get("trained_tokens") or 0), "peakMemoryGb": float(info.get("peak_memory") or 0)})

        def on_val_loss_report(self, info: dict) -> None:
            self._cancel()
            self.metrics.append({"step": int(info["iteration"]), "trainLoss": None, "validationLoss": float(info["val_loss"]), "learningRate": None, "trainedTokens": None, "peakMemoryGb": None})

        def _cancel(self) -> None:
            if Path(job["cancelPath"]).exists():
                raise CancelledTraining()

    class CancelledTraining(Exception):
        pass

    data = Path(job["dataDir"]).resolve()
    output = Path(job["outputDir"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in (data / "train.jsonl").read_text().splitlines() if line.strip()]
    valid_rows = [json.loads(line) for line in (data / "valid.jsonl").read_text().splitlines() if line.strip()]
    model, tokenizer = load(str(model_dir), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
    keys = sorted({name for name, _module in model.layers[0].named_modules() if name.endswith("q_proj") or name.endswith("v_proj")})
    if "self_attn.q_proj" not in keys or "self_attn.v_proj" not in keys:
        raise WorkerError(f"allowlisted projections were not found: {keys}")
    mode = str(job.get("target", "answer"))
    train_set = AnswerDataset(rows, tokenizer, mode)
    valid_set = AnswerDataset(valid_rows, tokenizer, mode)
    # Fail before the first optimizer step if the mask is wrong.
    _tokens, _offset = train_set.process(train_set[0])
    decoded = tokenizer.decode(_tokens[_offset:])
    if rows[0]["messages"][1]["content"] not in decoded or "Expression" in decoded:
        raise WorkerError("loss mask does not isolate the verified integer")
    np.random.seed(int(job["seed"]))
    args = train_args(job, data, output, keys, steps=int(job["steps"]), seed=int(job["seed"]))
    callback = Capture()
    cancelled = False
    try:
        train_model(args, model, train_set, valid_set, callback)
    except CancelledTraining:
        cancelled = True
    after = base_weight_hash(model_dir)
    if after != before:
        raise WorkerError("base checkpoint changed during training")
    artifact = output / "adapters.safetensors"
    trainable = sum(value.size for _name, value in tree_flatten(model.trainable_parameters()))
    if not cancelled and (not artifact.is_file() or trainable <= 0):
        raise WorkerError("training did not produce LoRA weights")
    (output / "result.json").write_text(
        json.dumps(
            {
                "cancelled": cancelled,
                "artifactPath": str(artifact) if artifact.is_file() else None,
                "adapterSha256": sha256_file(artifact) if artifact.is_file() else None,
                "durationMs": int((time.perf_counter() - started) * 1000),
                "peakMemoryBytes": int(mx.get_peak_memory()) if hasattr(mx, "get_peak_memory") else None,
                "metrics": callback.metrics,
                "trainableParameters": int(trainable),
                "adaptedModules": keys,
                "baseSha256": after,
                "baseUnchanged": True,
                "maskedTarget": decoded,
                "exampleCount": len(rows),
                "trainableL2": adapter_l2(model),
                "target": job.get("target", "answer"),
            }
        )
    )


def adapter_l2(model) -> float:
    import mlx.core as mx
    from mlx.utils import tree_flatten

    total = mx.array(0.0)
    for _name, value in tree_flatten(model.trainable_parameters()):
        cast = value.astype(mx.float32)
        total = total + (cast * cast).sum()
    return float(mx.sqrt(total))


def projection_keys(model) -> list[str]:
    keys = sorted({name for name, _module in model.layers[0].named_modules() if name.endswith("q_proj") or name.endswith("v_proj")})
    if "self_attn.q_proj" not in keys or "self_attn.v_proj" not in keys:
        raise WorkerError(f"allowlisted projections were not found: {keys}")
    return keys


def train_args(job: dict, data: Path, output: Path, keys: list[str], steps: int, seed: int):
    return types.SimpleNamespace(
        model=str(Path(job["modelPath"]).resolve()),
        train=True,
        test=False,
        data=str(data),
        fine_tune_type="lora",
        optimizer="adamw",
        optimizer_config={"adam": {}, "adamw": {}, "sgd": {}, "adafactor": {}, "muon": {}},
        seed=seed,
        num_layers=int(job["numLayers"]),
        batch_size=int(job["batchSize"]),
        iters=steps,
        val_batches=4,
        learning_rate=float(job["learningRate"]),
        steps_per_report=1,
        steps_per_eval=max(steps, 1),
        adapter_path=str(output),
        save_every=10_000,
        max_seq_length=int(job["maxSeq"]),
        grad_checkpoint=True,
        grad_accumulation_steps=int(job.get("gradAccum", 1)) if steps > 1 else 1,
        clear_cache_threshold=0,
        lr_schedule=None,
        lora_parameters={"rank": int(job["rank"]), "dropout": 0.0, "scale": 2.0, "keys": keys},
        mask_prompt=True,
        resume_adapter_file=None,
        trust_remote_code=False,
    )


def main() -> None:
    job = load_job(sys.argv)
    if job["command"] == "validate":
        return
    run_mlx(job)


if __name__ == "__main__":
    try:
        main()
    except WorkerError as error:
        fail(str(error))
    except Exception as error:
        fail(f"{type(error).__name__}: {error}")
