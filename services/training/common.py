"""Shared checks for the allowlisted MLX-LM worker.

The control plane may launch only train_lora.py, eval_lora.py, and generate_lora.py.
This module refuses every other profile, family, and path.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CHECKPOINTS = (ROOT / "checkpoints").resolve()
ARTIFACTS = (ROOT / "artifacts").resolve()
HF_CACHE = (Path.home() / ".cache" / "huggingface").resolve()
PROFILE = "gemma3-270m-math-v1"
EXPECTED = {
    "rank": 8,
    "scale": 2.0,
    "dropout": 0.0,
    "learningRate": 0.0001,
    "batchSize": 1,
    "gradAccum": 1,
    "maxSeq": 256,
    "steps": 40,
    "numLayers": 4,
}


class WorkerError(Exception):
    pass


def load_job(argv: list[str]) -> dict:
    if len(argv) != 3 or argv[1] != "--job":
        raise WorkerError("usage: script --job <path>")
    path = Path(argv[2]).resolve()
    if not inside(path, ARTIFACTS):
        raise WorkerError("job path escapes the artifact root")
    job = json.loads(path.read_text())
    if job.get("profile") != PROFILE or job.get("family") != "gemma-3":
        raise WorkerError("job is outside the Gemma 3 270M allowlist")
    if "qwen" in json.dumps(job).lower():
        raise WorkerError("Qwen is isolated from the training worker")
    return job


def inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root)
        return True
    except ValueError:
        return False


def checkpoint_path(value: str) -> Path:
    lexical = Path(value).resolve()
    if not inside(lexical, CHECKPOINTS):
        raise WorkerError("checkpoint path escapes the checkpoint root")
    real = lexical.resolve()
    if not (inside(real, CHECKPOINTS) or inside(real, HF_CACHE)):
        raise WorkerError("checkpoint resolves outside the allowlisted roots")
    return lexical


def artifact_dir(value: str) -> Path:
    path = Path(value).resolve()
    if not inside(path, ARTIFACTS):
        raise WorkerError("output path escapes the artifact root")
    path.mkdir(parents=True, exist_ok=True)
    return path


def assert_training_config(job: dict) -> None:
    for key, expected in EXPECTED.items():
        actual = job.get(key)
        if isinstance(expected, float):
            if abs(float(actual) - expected) > 1e-12:
                raise WorkerError(f"{key} is not the allowlisted value")
        elif actual != expected:
            raise WorkerError(f"{key} is not the allowlisted value")
    seed = job.get("seed")
    if not isinstance(seed, int) or seed < 0 or seed > 2_147_483_647:
        raise WorkerError("seed is outside the allowlist")
    modules = job.get("targetModules")
    if modules != ["q_proj", "v_proj"]:
        raise WorkerError("target modules are not allowlisted")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def base_weight_hash(model_dir: Path) -> str:
    files = sorted(path for path in model_dir.glob("*.safetensors") if path.is_file())
    if not files:
        raise WorkerError("base checkpoint has no safetensors weights")
    return hashlib.sha256("".join(f"{path.name}:{sha256_file(path)}" for path in files).encode()).hexdigest()


def refuse_test_split(data_dir: Path) -> None:
    if (data_dir / "test.jsonl").exists():
        raise WorkerError("the held-out test split must not be visible to training")
    names = {path.name for path in data_dir.iterdir()}
    if not {"train.jsonl", "valid.jsonl"}.issubset(names):
        raise WorkerError("training data must contain train.jsonl and valid.jsonl")


def write_result(directory: Path, payload: dict) -> None:
    (directory / "result.json").write_text(json.dumps(payload))


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)
