#!/usr/bin/env python3
"""Gemma 3 27B Instruct reviewer proposal for C1.8D blind LLM audit.

Local vLLM serve on RTX PRO 6000 Blackwell 96 GB. Different model family from
Qwen3-8B. Judgments are never ground truth.

This module is configuration + planning only — it does not start GPU workloads.
"""

from __future__ import annotations

from typing import Any

# Pinned from https://huggingface.co/api/models/google/gemma-3-27b-it (2025-03-21).
# Re-verify with ./scripts/c18d1-resolve-revisions-style check before execute.
PINNED_GEMMA3_27B_IT = {
    "modelId": "google/gemma-3-27b-it",
    "tokenizerId": "google/gemma-3-27b-it",
    "modelRevision": "005ad3404e59d6023443cb575daa05336842228a",
    "tokenizerRevision": "005ad3404e59d6023443cb575daa05336842228a",
    "sameRepositoryRevision": True,
    "modelFamily": "gemma3",
    "source": "huggingface.co/api/models/google/gemma-3-27b-it",
    "resolvedAt": "2026-11-14T21:50:00.000Z",
    "gated": True,
    "license": "gemma",
    "note": (
        "Gated HF repo — accept Google Gemma license and set HF_TOKEN before download. "
        "Multimodal architecture; audit uses text-only prompts (no images)."
    ),
}

# Preferred serving plan for 96 GiB Blackwell.
SERVING_CONFIG_BF16 = {
    "id": "c18d1-gemma3-27b-it-vllm-bf16-v1",
    "backend": "vllm",
    "dtype": "bfloat16",
    "quantization": None,
    "tensorParallelSize": 1,
    "gpuMemoryUtilization": 0.85,
    "maxModelLen": 4096,
    "maxNumSeqs": 32,
    "limitMmPerPrompt": {"image": 0},
    "enforceEager": False,
    "trustRemoteCode": True,
    "port": 8001,
    "host": "127.0.0.1",
    "vramEstimateGiB": {
        "weightsBf16": 54,
        "activationsKvHeadroom": 20,
        "gpuTotal": 96,
        "fitAssessment": "comfortable_bf16_on_96gib_with_max_model_len_4096",
    },
    "fallbackIfOom": "c18d1-gemma3-27b-it-vllm-awq-v1",
}

# Supported quantized fallback (only if BF16 fails on installed vLLM/GPU).
SERVING_CONFIG_AWQ_FALLBACK = {
    "id": "c18d1-gemma3-27b-it-vllm-awq-v1",
    "backend": "vllm",
    "dtype": "auto",
    "quantization": "awq",
    "modelIdOverride": None,  # use official AWQ repo only if pinned later
    "tensorParallelSize": 1,
    "gpuMemoryUtilization": 0.85,
    "maxModelLen": 8192,
    "maxNumSeqs": 64,
    "note": (
        "Fallback only. Prefer BF16. If used, pin a specific AWQ revision and "
        "re-run the smoke validation set before the full 307-case audit."
    ),
}

COMPATIBILITY_CHECKS = {
    "minVllmVersion": "0.8.3",
    "recommendedVllmVersion": ">=0.8.5 (Gemma 3 multimodal text path)",
    "minTransformersVersion": "4.50.0",
    "cudaArch": "Blackwell (sm_100+) — use the same .venv-vllm that serves Qwen3-8B if it already runs on this GPU",
    "sequencing": (
        "Fully exit any Qwen3-8B vLLM engine (process exit) before loading Gemma. "
        "Do not co-reside Qwen (~88 GiB KV) and Gemma on the same 96 GiB device."
    ),
    "hfAuth": "HF_TOKEN with access to google/gemma-3-27b-it",
    "operatorChecksBeforeServe": [
        "python -c 'import vllm; print(vllm.__version__)'  # require >= 0.8.3",
        "python -c 'import transformers; print(transformers.__version__)'  # require >= 4.50",
        "nvidia-smi  # confirm 96 GiB free / no leftover Qwen process",
        "huggingface-cli whoami  # gated model access",
    ],
}

REVIEWER_SAMPLING = {
    "temperature": 0.0,
    "topP": 1.0,
    "maxTokens": 400,
    "doSample": False,
    "seed": 18,
}

# Blind-audit design preserved from prepare step (typical full-dev regrade).
AUDIT_DESIGN = {
    "specVersion": "c18d1-blind-llm-audit-v1",
    "expectedCaseCount": 307,
    "includes": [
        "all regraded wrong / invalid / truncated / grader_error",
        "stratified ~10% sample of regraded correct by family × thinking mode",
        "high-risk original→corrected transitions",
    ],
    "blindTo": ["expected answer", "original grade", "corrected grade", "grader rationale"],
    "adjudication": "SymPy + independent_check; Gemma never ground truth",
}

PROPOSED_REVIEWER = {
    "provider": "local-vllm",
    "modelId": PINNED_GEMMA3_27B_IT["modelId"],
    "modelRevision": PINNED_GEMMA3_27B_IT["modelRevision"],
    "modelFamily": "gemma3",
    "evaluatedModelFamily": "qwen3",
    "familySeparation": True,
    "rationale": (
        "Google Gemma 3 27B Instruct via local vLLM on RTX PRO 6000 96 GB — "
        "different family from Qwen3-8B under audit; no paid API."
    ),
    "sampling": REVIEWER_SAMPLING,
    "serving": SERVING_CONFIG_BF16,
    "servingFallback": SERVING_CONFIG_AWQ_FALLBACK,
    "compatibility": COMPATIBILITY_CHECKS,
    "pinned": PINNED_GEMMA3_27B_IT,
    # Local GPU economics (not API token pricing).
    "estimatedTokensPerCase": {"input": 1200, "output": 150},
    "estimatedSecondsPerCaseBatched": 2.5,
    "estimatedModelLoadMinutes": 4.0,
    "estimatedGpuHourlyOpportunityUsd": 0.0,  # operator-owned GPU; report hours not API $
}


def estimate_runtime(
    n_cases: int = 307,
    reviewer: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """GPU runtime estimate before full audit (no launch)."""
    rev = reviewer or PROPOSED_REVIEWER
    per = float(rev["estimatedSecondsPerCaseBatched"])
    load_min = float(rev["estimatedModelLoadMinutes"])
    gen_sec = n_cases * per
    smoke_sec = 12 * per + 60  # small validation set overhead
    total_sec = load_min * 60 + smoke_sec + gen_sec
    gpu_hours = total_sec / 3600.0
    return {
        "caseCount": n_cases,
        "validationCaseCount": 12,
        "estimatedModelLoadMinutes": load_min,
        "estimatedSecondsPerCaseBatched": per,
        "estimatedGenerationMinutes": round(gen_sec / 60.0, 1),
        "estimatedSmokeMinutes": round(smoke_sec / 60.0, 1),
        "estimatedTotalGpuMinutes": round(total_sec / 60.0, 1),
        "estimatedGpuHours": round(gpu_hours, 2),
        "estimatedApiUsd": 0.0,
        "costBasis": "local_rtx_pro_6000_opportunity_hours",
        "dtype": SERVING_CONFIG_BF16["dtype"],
        "servingConfigId": SERVING_CONFIG_BF16["id"],
        "note": (
            "Estimate only — confirm after smoke validation throughput. "
            "Do not launch full audit until approved."
        ),
        "reviewer": {
            "provider": rev["provider"],
            "modelId": rev["modelId"],
            "modelRevision": rev["modelRevision"],
            "modelFamily": rev["modelFamily"],
        },
    }


def vllm_serve_command(cfg: dict[str, Any] | None = None) -> str:
    """Exact proposed serve command (documentation / future execute only)."""
    c = cfg or SERVING_CONFIG_BF16
    pin = PINNED_GEMMA3_27B_IT
    return (
        f"# PROPOSED — do not run until approved\n"
        f"export HF_TOKEN=…  # gated access to {pin['modelId']}\n"
        f"# Ensure Qwen vLLM process has fully exited; nvidia-smi clean\n"
        f"{'${C18D1_VLLM_PYTHON:-python}'} -m vllm.entrypoints.openai.api_server \\\n"
        f"  --model {pin['modelId']} \\\n"
        f"  --revision {pin['modelRevision']} \\\n"
        f"  --tokenizer {pin['tokenizerId']} \\\n"
        f"  --tokenizer-revision {pin['tokenizerRevision']} \\\n"
        f"  --dtype {c['dtype']} \\\n"
        f"  --gpu-memory-utilization {c['gpuMemoryUtilization']} \\\n"
        f"  --max-model-len {c['maxModelLen']} \\\n"
        f"  --max-num-seqs {c['maxNumSeqs']} \\\n"
        f"  --limit-mm-per-prompt image=0 \\\n"
        f"  --host {c['host']} --port {c['port']} \\\n"
        f"  --trust-remote-code"
    )


def proposal_payload() -> dict[str, Any]:
    return {
        "ok": True,
        "status": "proposed_awaiting_approval",
        "gpuWorkloadAuthorized": False,
        "auditDesign": AUDIT_DESIGN,
        "proposedReviewer": PROPOSED_REVIEWER,
        "runtimeEstimate": estimate_runtime(AUDIT_DESIGN["expectedCaseCount"]),
        "vllmServeCommand": vllm_serve_command(),
        "executionPlan": [
            "1. Compatibility: vLLM>=0.8.3, transformers>=4.50, HF gated access, free 96 GiB",
            "2. Exit Qwen evaluation engine completely",
            "3. Serve Gemma BF16 with pinned revision (command above)",
            "4. Smoke-validate on 12 independently verified correct/incorrect Math packets",
            "5. If smoke OK → full 307-case blind audit (packets hide expected/grades)",
            "6. Adjudicate disagreements with SymPy/independent_check; escalate unresolved",
            "7. Record revision, serve config, prompt, all judgments",
            "8. Tear down Gemma before any further Qwen Stage work",
        ],
        "validationGate": (
            "Full audit blocked until smoke validation passes and operator sets "
            "C18D1_LLM_AUDIT_CONFIRM=1 after approving this proposal."
        ),
    }


def main() -> None:
    import json

    print(json.dumps(proposal_payload(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
