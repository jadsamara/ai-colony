#!/usr/bin/env python3
"""Benchmark Hugging Face vs experimental vLLM for thinking-enabled Qwen3-8B.

Official backend remains huggingface-batched. This script never silently
replaces it. Development items only; no locked access.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from accounting import build_accounting
from decoding import CONDITIONS, matched_job_fields, sampling_seed_schedule
from generation_utils import (
    EVAL_IMPLEMENTATION_VERSION,
    FINAL_ANSWER_INSTRUCTION,
    OFFICIAL_BACKEND,
    apply_sampling_seed,
    assert_left_padding,
    build_generate_kwargs,
    filter_unsupported_generate_kwargs,
    prompt_token_length,
    slice_new_token_ids,
)
from reproducibility import build_reproducibility_manifest
from revisions import PINNED_QWEN3_8B, require_for_baseline, verify_pinned
from dev_provenance import DevelopmentProvenanceError, assert_authorized_development_dataset
from stratified_selection import dataset_content_hash
from sympy_grader import grade_model_output
from vllm_backend import BACKEND_ID as VLLM_BACKEND
from vllm_backend import BACKEND_STATUS, build_prompts, generate_texts_vllm, load_vllm_engine

ROOT = Path(__file__).resolve().parent


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _peak_vram_bytes(torch: Any) -> int | None:
    if torch.cuda.is_available():
        return int(torch.cuda.max_memory_allocated())
    return None


def run_hf_benchmark(
    *,
    items: list[dict[str, Any]],
    fields: dict[str, Any],
    pin: dict[str, Any],
    batch_size: int,
    seed: int,
    device: str,
) -> dict[str, Any]:
    import sys

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts, template_fingerprint

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    load_t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"], revision=pin["tokenizerRevision"], trust_remote_code=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    assert_left_padding(tokenizer)
    model = AutoModelForCausalLM.from_pretrained(
        pin["modelId"],
        revision=pin["modelRevision"],
        trust_remote_code=True,
        torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32,
    )
    if device != "cpu":
        model.to(device)
    model.eval()
    load_ms = int((time.time() - load_t0) * 1000)
    tmpl_fp = template_fingerprint(tokenizer)

    results: list[dict[str, Any]] = []
    samples_per = int(fields["samplesPerProblem"])
    eval_t0 = time.time()
    total_new_tokens = 0

    for start in range(0, len(items), batch_size):
        batch = items[start : start + batch_size]
        for sample_index in range(samples_per):
            prompts = []
            for item in batch:
                user = f"{item['prompt']}\n\n{FINAL_ANSWER_INSTRUCTION}"
                prompt, _ = build_chat_texts(
                    tokenizer, user, None, enable_thinking=bool(fields["enableThinking"]),
                )
                prompts.append(prompt)
            gen_base = filter_unsupported_generate_kwargs(
                build_generate_kwargs(
                    fields=fields,
                    pad_token_id=tokenizer.pad_token_id,
                    eos_token_id=tokenizer.eos_token_id,
                ),
            )
            if fields["doSample"]:
                for row_index, item in enumerate(batch):
                    item_index = start + row_index
                    sample_seed = sampling_seed_schedule(seed, item_index, sample_index)
                    apply_sampling_seed(torch, sample_seed, device=device)
                    t0 = time.time()
                    encoded = tokenizer([prompts[row_index]], return_tensors="pt", padding=True)
                    encoded = {k: v.to(device) for k, v in encoded.items()}
                    prompt_len = prompt_token_length(int(encoded["input_ids"].shape[1]))
                    with torch.no_grad():
                        generated = model.generate(**encoded, **gen_base)
                    new_tokens = slice_new_token_ids(generated[0], prompt_len)
                    text = tokenizer.decode(new_tokens, skip_special_tokens=True)
                    runtime_ms = (time.time() - t0) * 1000.0
                    n_tok = int(new_tokens.shape[0])
                    total_new_tokens += n_tok
                    truncated = n_tok >= int(fields["maxNewTokens"])
                    if tokenizer.eos_token_id is not None and tokenizer.eos_token_id in set(new_tokens.tolist()):
                        truncated = False
                    graded = grade_model_output(
                        text, item["expected"],
                        enable_thinking=bool(fields["enableThinking"]), truncated=truncated,
                    )
                    results.append(
                        {
                            "itemId": item["id"],
                            "family": item["family"],
                            "difficulty": item["difficulty"],
                            "sampleIndex": sample_index,
                            "samplingSeed": sample_seed,
                            "rawPrediction": text,
                            "truncated": truncated,
                            "outcome": graded["outcome"],
                            "correct": graded["correct"],
                            "mathematicalCorrect": graded.get("mathematicalCorrect", graded["correct"]),
                            "formatCompliant": graded.get("formatCompliant", False),
                            "thinkingProtocolViolation": graded.get("thinkingProtocolViolation", False),
                            "invalidReason": graded.get("invalidReason"),
                            "parsed": graded["parsed"],
                            "grade": graded["grade"],
                            "generatedTokens": n_tok,
                            "runtimeMs": runtime_ms,
                        },
                    )
            else:
                t0 = time.time()
                encoded = tokenizer(prompts, return_tensors="pt", padding=True)
                encoded = {k: v.to(device) for k, v in encoded.items()}
                prompt_len = prompt_token_length(int(encoded["input_ids"].shape[1]))
                with torch.no_grad():
                    generated = model.generate(**encoded, **gen_base)
                batch_ms = (time.time() - t0) * 1000.0
                for row_index, item in enumerate(batch):
                    new_tokens = slice_new_token_ids(generated[row_index], prompt_len)
                    text = tokenizer.decode(new_tokens, skip_special_tokens=True)
                    n_tok = int(new_tokens.shape[0])
                    total_new_tokens += n_tok
                    truncated = n_tok >= int(fields["maxNewTokens"])
                    if tokenizer.eos_token_id is not None and tokenizer.eos_token_id in set(new_tokens.tolist()):
                        truncated = False
                    graded = grade_model_output(
                        text, item["expected"],
                        enable_thinking=bool(fields["enableThinking"]), truncated=truncated,
                    )
                    results.append(
                        {
                            "itemId": item["id"],
                            "family": item["family"],
                            "difficulty": item["difficulty"],
                            "sampleIndex": sample_index,
                            "samplingSeed": sampling_seed_schedule(seed, start + row_index, sample_index),
                            "rawPrediction": text,
                            "truncated": truncated,
                            "outcome": graded["outcome"],
                            "correct": graded["correct"],
                            "mathematicalCorrect": graded.get("mathematicalCorrect", graded["correct"]),
                            "formatCompliant": graded.get("formatCompliant", False),
                            "thinkingProtocolViolation": graded.get("thinkingProtocolViolation", False),
                            "invalidReason": graded.get("invalidReason"),
                            "parsed": graded["parsed"],
                            "grade": graded["grade"],
                            "generatedTokens": n_tok,
                            "runtimeMs": batch_ms / max(len(batch), 1),
                        },
                    )

    eval_ms = int((time.time() - eval_t0) * 1000)
    accounting = build_accounting(results, samples_per_problem=samples_per)
    peak = _peak_vram_bytes(torch)
    return {
        "backend": OFFICIAL_BACKEND,
        "official": True,
        "templateFingerprint": tmpl_fp,
        "results": results,
        "accounting": accounting,
        "timing": {"modelLoadMs": load_ms, "evalMs": eval_ms, "wallClockMs": load_ms + eval_ms},
        "totalGeneratedTokens": total_new_tokens,
        "tokensPerSecond": (total_new_tokens / (eval_ms / 1000.0)) if eval_ms else None,
        "peakVramBytes": peak,
        "libraries": {
            "torch": torch.__version__,
            "transformers": __import__("transformers").__version__,
        },
    }


def run_vllm_benchmark(
    *,
    items: list[dict[str, Any]],
    fields: dict[str, Any],
    pin: dict[str, Any],
    seed: int,
) -> dict[str, Any]:
    import sys

    import torch
    from transformers import AutoTokenizer

    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts, template_fingerprint

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    load_t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(
        pin["tokenizerId"], revision=pin["tokenizerRevision"], trust_remote_code=True,
    )
    tmpl_fp = template_fingerprint(tokenizer)
    llm = load_vllm_engine(pin)
    load_ms = int((time.time() - load_t0) * 1000)

    prompts = build_prompts(
        items, tokenizer,
        enable_thinking=bool(fields["enableThinking"]),
        build_chat_texts=build_chat_texts,
    )
    samples_per = int(fields["samplesPerProblem"])
    results: list[dict[str, Any]] = []
    total_new_tokens = 0
    eval_t0 = time.time()
    for sample_index in range(samples_per):
        t0 = time.time()
        gens = generate_texts_vllm(
            llm=llm,
            prompts=prompts,
            fields=fields,
            base_seed=seed,
            item_indices=list(range(len(items))),
            sample_index=sample_index,
        )
        elapsed = (time.time() - t0) * 1000.0
        for item, gen in zip(items, gens):
            text = gen["text"]
            n_tok = int(gen["generatedTokens"])
            total_new_tokens += n_tok
            truncated = n_tok >= int(fields["maxNewTokens"]) and gen.get("finishReason") != "stop"
            graded = grade_model_output(
                text, item["expected"],
                enable_thinking=bool(fields["enableThinking"]), truncated=truncated,
            )
            results.append(
                {
                    "itemId": item["id"],
                    "family": item["family"],
                    "difficulty": item["difficulty"],
                    "sampleIndex": sample_index,
                    "samplingSeed": gen.get("samplingSeed"),
                    "rawPrediction": text,
                    "truncated": truncated,
                    "outcome": graded["outcome"],
                    "correct": graded["correct"],
                    "mathematicalCorrect": graded.get("mathematicalCorrect", graded["correct"]),
                    "formatCompliant": graded.get("formatCompliant", False),
                    "thinkingProtocolViolation": graded.get("thinkingProtocolViolation", False),
                    "invalidReason": graded.get("invalidReason"),
                    "parsed": graded["parsed"],
                    "grade": graded["grade"],
                    "generatedTokens": n_tok,
                    "runtimeMs": elapsed / max(len(items), 1),
                },
            )
    eval_ms = int((time.time() - eval_t0) * 1000)
    accounting = build_accounting(results, samples_per_problem=samples_per)
    return {
        "backend": VLLM_BACKEND,
        "official": False,
        "backendStatus": BACKEND_STATUS,
        "templateFingerprint": tmpl_fp,
        "results": results,
        "accounting": accounting,
        "timing": {"modelLoadMs": load_ms, "evalMs": eval_ms, "wallClockMs": load_ms + eval_ms},
        "totalGeneratedTokens": total_new_tokens,
        "tokensPerSecond": (total_new_tokens / (eval_ms / 1000.0)) if eval_ms else None,
        "peakVramBytes": _peak_vram_bytes(torch),
        "pythonExecutable": sys.executable,
        "libraries": {
            "torch": torch.__version__,
            "vllm": getattr(__import__("vllm"), "__version__", None),
        },
        "eligibilityNote": (
            "vLLM continuous batching varies batch composition. Not official unless "
            "same-config repeatability passes (see vllm_repeatability.py)."
        ),
    }


def _run_vllm_via_separate_interpreter(job: dict[str, Any], out: Path) -> dict[str, Any]:
    """Execute vLLM benchmark in C18D1_VLLM_PYTHON — never the HF venv."""
    vllm_python = job.get("vllmPython") or ""
    if not vllm_python:
        return {
            "backend": VLLM_BACKEND,
            "official": False,
            "ok": False,
            "error": "vllmPython / C18D1_VLLM_PYTHON not set",
            "backendStatus": BACKEND_STATUS,
            "note": "vLLM must use a separate venv (e.g. tmp/c18d1/.venv-vllm).",
        }
    fragment = out / "vllm-run-fragment.json"
    child_job = dict(job)
    child_job["backends"] = ["vllm"]
    child_job_path = out / "vllm-only-job.json"
    _write_json(child_job_path, child_job)
    cmd = [
        str(vllm_python),
        str(Path(__file__).resolve()),
        "--job",
        str(child_job_path),
        "--vllm-only",
        "--write-fragment",
        str(fragment),
    ]
    try:
        proc = subprocess.run(cmd, check=False, capture_output=True, text=True)
    except OSError as exc:
        return {
            "backend": VLLM_BACKEND,
            "official": False,
            "ok": False,
            "error": f"failed_to_exec_vllm_python: {exc}",
            "vllmPython": vllm_python,
            "backendStatus": BACKEND_STATUS,
        }
    if proc.returncode != 0 or not fragment.exists():
        return {
            "backend": VLLM_BACKEND,
            "official": False,
            "ok": False,
            "error": f"vllm_subprocess_failed_rc={proc.returncode}",
            "stderr": (proc.stderr or "")[-4000:],
            "stdout": (proc.stdout or "")[-2000:],
            "vllmPython": vllm_python,
            "backendStatus": BACKEND_STATUS,
        }
    payload = json.loads(fragment.read_text(encoding="utf-8"))
    payload["vllmPython"] = vllm_python
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=Path, required=True)
    parser.add_argument("--vllm-only", action="store_true", help="Run only the vLLM backend (separate venv).")
    parser.add_argument("--write-fragment", type=Path, default=None)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding="utf-8"))
    for key in ("modelId", "modelRevision", "tokenizerRevision"):
        job.setdefault(key, PINNED_QWEN3_8B[key])
    job.setdefault("tokenizerId", PINNED_QWEN3_8B["tokenizerId"])

    require_for_baseline(job)
    pin = verify_pinned()
    dataset_path = Path(job["datasetPath"])
    manifest_path = Path(job["selectionManifestPath"]) if job.get("selectionManifestPath") else None
    try:
        provenance = assert_authorized_development_dataset(
            dataset_path,
            manifest_path=manifest_path,
        )
    except DevelopmentProvenanceError as exc:
        raise SystemExit(f"DEVELOPMENT_PROVENANCE_DENIED: {exc}") from exc
    dataset_path = Path(provenance["datasetPath"])
    items = _load_jsonl(dataset_path)
    if job.get("limit"):
        items = items[: int(job["limit"])]

    condition = CONDITIONS[job.get("conditionId") or "thinking_enabled_zero_shot"]
    fields = matched_job_fields(condition)
    # Optional shorter thinking pilot override
    if job.get("maxNewTokens"):
        fields = {**fields, "maxNewTokens": int(job["maxNewTokens"])}
    if job.get("samplesPerProblem") is not None:
        fields = {**fields, "samplesPerProblem": int(job["samplesPerProblem"])}

    out = Path(job["outputDir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    seed = int(job.get("seed") or 18)
    batch_size = int(job.get("batchSize") or 4)
    device = job.get("device") or "cuda"
    backends = job.get("backends") or ["huggingface", "vllm"]
    if args.vllm_only:
        backends = ["vllm"]

    from answer_parser import GRADER_VERSION

    report: dict[str, Any] = {
        "ok": True,
        "benchmark": "c18d1-backend-benchmark-v2",
        "evaluationImplementationVersion": EVAL_IMPLEMENTATION_VERSION,
        "graderVersion": GRADER_VERSION,
        "officialBackend": OFFICIAL_BACKEND,
        "conditionId": job.get("conditionId") or "thinking_enabled_zero_shot",
        "decoding": fields,
        "pinned": pin,
        "datasetPath": str(dataset_path),
        "datasetContentHash": dataset_content_hash(items),
        "developmentProvenance": provenance,
        "itemCount": len(items),
        "batchSize": batch_size,
        "seed": seed,
        "hfPython": sys.executable if not args.vllm_only else job.get("hfPython"),
        "vllmPython": job.get("vllmPython"),
        "runs": {},
        "note": (
            "Does not replace official HF backend. Development items only. "
            "vLLM must run from a separate interpreter (C18D1_VLLM_PYTHON)."
        ),
    }

    if ("huggingface" in backends or "hf" in backends) and not args.vllm_only:
        hf = run_hf_benchmark(
            items=items, fields=fields, pin=pin, batch_size=batch_size, seed=seed, device=device,
        )
        hf_public = {k: v for k, v in hf.items() if k != "results"}
        hf_public["pythonExecutable"] = sys.executable
        try:
            import torch as _torch
            import transformers as _tf

            hf_public["libraries"] = {
                **(hf_public.get("libraries") or {}),
                "torch": _torch.__version__,
                "transformers": _tf.__version__,
            }
        except ImportError:
            pass
        report["runs"]["huggingface"] = hf_public
        _write_json(out / "hf-item-results.json", {"access": "evaluation_only", "results": hf["results"]})
        report["reproducibility"] = build_reproducibility_manifest(
            pinned=pin,
            decoding=fields,
            batch_size=batch_size,
            dataset_path=dataset_path,
            dataset_content_hash=report["datasetContentHash"],
            backend=OFFICIAL_BACKEND,
            template_fingerprint=hf.get("templateFingerprint"),
            condition_id=report["conditionId"],
            seed=seed,
            extra={"graderVersion": GRADER_VERSION},
        )

    if "vllm" in backends:
        if args.vllm_only:
            # Running inside the dedicated vLLM interpreter.
            try:
                vl = run_vllm_benchmark(items=items, fields=fields, pin=pin, seed=seed)
                fragment = {k: v for k, v in vl.items() if k != "results"}
                fragment["ok"] = True
                fragment["graderVersion"] = GRADER_VERSION
                _write_json(out / "vllm-item-results.json", {"access": "evaluation_only", "results": vl["results"]})
                if args.write_fragment:
                    _write_json(args.write_fragment, fragment)
                report["runs"]["vllm"] = fragment
            except Exception as exc:  # noqa: BLE001
                fragment = {
                    "backend": VLLM_BACKEND,
                    "official": False,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "backendStatus": BACKEND_STATUS,
                    "pythonExecutable": sys.executable,
                }
                if args.write_fragment:
                    _write_json(args.write_fragment, fragment)
                report["runs"]["vllm"] = fragment
                raise SystemExit(2) from exc
        else:
            report["runs"]["vllm"] = _run_vllm_via_separate_interpreter(job, out)

    # Side-by-side summary when both present
    if "huggingface" in report["runs"] and report["runs"].get("vllm", {}).get("accounting"):
        hf_acc = report["runs"]["huggingface"]["accounting"]["perSample"]
        vl_acc = report["runs"]["vllm"]["accounting"]["perSample"]
        report["comparison"] = {
            "passAt1": {
                "huggingface": report["runs"]["huggingface"]["accounting"]["passAt1"],
                "vllm": report["runs"]["vllm"]["accounting"]["passAt1"],
            },
            "formatComplianceRate": {
                "huggingface": hf_acc["formatComplianceRate"],
                "vllm": vl_acc["formatComplianceRate"],
            },
            "truncationRate": {
                "huggingface": hf_acc["truncationRate"],
                "vllm": vl_acc["truncationRate"],
            },
            "tokensPerSecond": {
                "huggingface": report["runs"]["huggingface"].get("tokensPerSecond"),
                "vllm": report["runs"]["vllm"].get("tokensPerSecond"),
            },
            "peakVramBytes": {
                "huggingface": report["runs"]["huggingface"].get("peakVramBytes"),
                "vllm": report["runs"]["vllm"].get("peakVramBytes"),
            },
            "wallClockMs": {
                "huggingface": report["runs"]["huggingface"]["timing"]["wallClockMs"],
                "vllm": report["runs"]["vllm"]["timing"]["wallClockMs"],
            },
        }

    _write_json(out / "backend-benchmark-report.json", report)
    print(json.dumps({"ok": True, "outputDir": str(out), "backends": list(report["runs"].keys())}, indent=2))


if __name__ == "__main__":
    main()
