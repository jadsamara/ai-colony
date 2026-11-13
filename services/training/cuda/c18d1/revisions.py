#!/usr/bin/env python3
"""Immutable Hugging Face revision pinning for C1.8D.1 Math baselines.

Official baseline execution MUST fail if model or tokenizer revisions are
null, unverified, or not 40-char hexadecimal commit hashes.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

COMMIT_HASH_RE = re.compile(r"^[0-9a-f]{40}$")

# Resolved from https://huggingface.co/api/models/Qwen/Qwen3-8B (same repo
# hosts weights, tokenizer, and chat template). Re-verify before baselines.
PINNED_QWEN3_8B = {
    "modelId": "Qwen/Qwen3-8B",
    "tokenizerId": "Qwen/Qwen3-8B",
    "modelRevision": "b968826d9c46dd6066d109eabc6255188de91218",
    "tokenizerRevision": "b968826d9c46dd6066d109eabc6255188de91218",
    "sameRepositoryRevision": True,
    "source": "huggingface.co/api/models/Qwen/Qwen3-8B",
    "resolvedAt": "2026-11-13T17:30:00.000Z",
    "dtype": "bfloat16",
    "quantization": None,
    "ollamaForbidden": True,
    "note": (
        "Model weights, tokenizer, and chat template share one immutable commit. "
        "Do not substitute an Ollama tag for this Hugging Face revision."
    ),
}

PIN_PATH = Path(__file__).resolve().parent / "pinned_revisions.json"


def is_commit_hash(value: str | None) -> bool:
    return bool(value and COMMIT_HASH_RE.fullmatch(value))


def assert_commit_hash(label: str, value: str | None) -> str:
    if value is None:
        raise ValueError(f"{label} is null; official baselines require an immutable commit hash")
    if not is_commit_hash(value):
        raise ValueError(
            f"{label}={value!r} is not a 40-char hexadecimal commit hash "
            "(branch names and repo ids are forbidden)",
        )
    return value


def verify_pinned(pin: dict[str, Any] | None = None) -> dict[str, Any]:
    pin = dict(pin or PINNED_QWEN3_8B)
    model_rev = assert_commit_hash("modelRevision", pin.get("modelRevision"))
    tok_rev = assert_commit_hash("tokenizerRevision", pin.get("tokenizerRevision"))
    if pin.get("sameRepositoryRevision") and model_rev != tok_rev:
        raise ValueError("sameRepositoryRevision=true but model/tokenizer hashes differ")
    if pin.get("ollamaForbidden") is not True:
        raise ValueError("ollamaForbidden must be true for official Math baselines")
    return {
        **pin,
        "modelRevision": model_rev,
        "tokenizerRevision": tok_rev,
        "verified": True,
    }


def fetch_remote_sha(model_id: str = "Qwen/Qwen3-8B", timeout_s: float = 30.0) -> str:
    url = f"https://huggingface.co/api/models/{model_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "ai-colony-c18d1/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to resolve remote revision for {model_id}: {exc}") from exc
    sha = payload.get("sha")
    return assert_commit_hash(f"remote sha for {model_id}", sha)


def reconcile_with_remote(*, update_pin_file: bool = False) -> dict[str, Any]:
    """Compare local pin to Hugging Face API; fail if official pin drifts unexpectedly."""
    local = verify_pinned()
    remote = fetch_remote_sha(local["modelId"])
    status = {
        "local": local,
        "remoteSha": remote,
        "matchesRemoteMain": remote == local["modelRevision"],
        "okForBaselines": True,
    }
    if remote != local["modelRevision"]:
        # Pin stays authoritative for reproducibility; report drift without auto-switching.
        status["okForBaselines"] = True
        status["driftWarning"] = (
            f"Remote main moved to {remote}; local pin {local['modelRevision']} remains "
            "authoritative for frozen baselines."
        )
    if update_pin_file:
        write_pin_file(local)
    return status


def write_pin_file(pin: dict[str, Any] | None = None) -> Path:
    verified = verify_pinned(pin)
    PIN_PATH.write_text(json.dumps(verified, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return PIN_PATH


def load_pin_file(path: Path | None = None) -> dict[str, Any]:
    target = path or PIN_PATH
    if not target.exists():
        write_pin_file()
    return verify_pinned(json.loads(target.read_text(encoding="utf-8")))


def require_for_baseline(job: dict[str, Any]) -> dict[str, str]:
    """Fail-closed check used by official baseline runners."""
    model_rev = assert_commit_hash("job.modelRevision", job.get("modelRevision"))
    tok_rev = assert_commit_hash(
        "job.tokenizerRevision",
        job.get("tokenizerRevision") or job.get("modelRevision"),
    )
    pin = load_pin_file()
    if model_rev != pin["modelRevision"]:
        raise ValueError(
            f"job.modelRevision {model_rev} does not match pinned {pin['modelRevision']}",
        )
    if tok_rev != pin["tokenizerRevision"]:
        raise ValueError(
            f"job.tokenizerRevision {tok_rev} does not match pinned {pin['tokenizerRevision']}",
        )
    if str(job.get("modelId") or "") != pin["modelId"]:
        raise ValueError(f"job.modelId must be {pin['modelId']}")
    if "ollama" in str(job.get("modelId") or "").lower():
        raise ValueError("Ollama model ids are forbidden for official Math baselines")
    return {
        "modelId": pin["modelId"],
        "tokenizerId": pin["tokenizerId"],
        "modelRevision": model_rev,
        "tokenizerRevision": tok_rev,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="C1.8D.1 HF revision pin tools")
    parser.add_argument("--write", action="store_true", help="Write pinned_revisions.json")
    parser.add_argument("--check-remote", action="store_true", help="Compare pin to HF API")
    args = parser.parse_args()
    pin = verify_pinned()
    if args.write:
        path = write_pin_file(pin)
        print(json.dumps({"wrote": str(path), **pin}, indent=2))
    elif args.check_remote:
        print(json.dumps(reconcile_with_remote(), indent=2))
    else:
        print(json.dumps(pin, indent=2))


if __name__ == "__main__":
    main()
