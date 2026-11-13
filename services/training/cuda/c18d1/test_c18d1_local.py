#!/usr/bin/env python3
"""Local (CPU) unit tests for C1.8D.1 — no GPU required."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[3]
sys.path.insert(0, str(ROOT))

from access_control import LockedTestAccessError, assert_can_read_locked_items, can_read_locked_items
from answer_parser import GRADER_VERSION, parse_model_output
from batch_invariance_metrics import (
    BF16_FIRST_TOKEN_LOGIT_ABS_TOL,
    GATE_VERSION_V2,
    GATE_VERSION_V3,
    detect_prefix_artifacts,
    expected_left_pad_position_ids,
    first_token_diagnostics,
    gate_pass,
    gate_pass_v3,
    kl_divergence_f32,
    outcomes_agree,
    position_ids_aligned_with_unpadded,
)
from sympy_grader import answers_canonically_equal, grade_answer, grade_model_output
from generation_utils import (
    BATCHING_POLICY,
    EVAL_IMPLEMENTATION_VERSION,
    FINAL_ANSWER_INSTRUCTION,
    apply_sampling_seed,
    build_generate_kwargs,
    filter_unsupported_generate_kwargs,
    prompt_token_length,
    slice_new_token_ids,
)
from generators import prompt_leaks_split_identity
from locked_seeds import LockedSeedError, load_locked_stream_seeds
from revisions import assert_commit_hash, is_commit_hash, require_for_baseline, verify_pinned


def test_revisions() -> None:
    pin = verify_pinned()
    assert is_commit_hash(pin["modelRevision"])
    assert pin["modelRevision"] == pin["tokenizerRevision"]
    assert pin["sameRepositoryRevision"] is True
    try:
        assert_commit_hash("bad", "main")
        raise AssertionError("branch name must fail")
    except ValueError:
        pass
    try:
        assert_commit_hash("bad", None)
        raise AssertionError("null must fail")
    except ValueError:
        pass
    require_for_baseline(
        {
            "modelId": pin["modelId"],
            "modelRevision": pin["modelRevision"],
            "tokenizerRevision": pin["tokenizerRevision"],
        },
    )


def test_parser_adversarial() -> None:
    raw = "<think>The answer is 4</think>\nI am unsure."
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is False
    assert parsed["outcomeClass"] == "invalid"

    raw = "<think>x</think>\nANSWER: 1\nANSWER: 2"
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is False
    assert parsed["parseStatus"] == "ambiguous"

    raw = "<think></think>\nThe solution is clearly 7."
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is False
    assert parsed["reason"] == "no_answer_line"

    raw = "<think></think>\nANSWER: \\frac{1}{2}"
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is True
    assert parsed["formatCompliant"] is True

    graded = grade_model_output(
        "<think></think>\nANSWER: not 4 but nearby",
        {"kind": "roots", "values": ["4"]},
        enable_thinking=True,
    )
    assert graded["outcome"] == "wrong"

    parsed = parse_model_output("<think>still thinking", enable_thinking=True, truncated=True)
    assert parsed["outcomeClass"] in {"invalid", "truncated"}
    assert parsed["ok"] is False

    parsed = parse_model_output("<think>done</think>\n", enable_thinking=True)
    assert parsed["ok"] is False

    parsed = parse_model_output("<think></think>\nANSWER: 1", enable_thinking=False)
    assert parsed["ok"] is False
    assert parsed["reason"] == "unexpected_think_with_thinking_disabled"
    assert parsed["thinkingProtocolViolation"] is True


def test_unexpected_think_and_no_answer() -> None:
    parsed = parse_model_output("</think>\nWe solve...\n\\boxed{ANSWER: 1}", enable_thinking=False)
    assert parsed["ok"] is False
    assert parsed["reason"] == "unexpected_think_with_thinking_disabled"

    parsed = parse_model_output("Working...\nThe answer is 3.", enable_thinking=False)
    assert parsed["ok"] is False
    assert parsed["reason"] == "no_answer_line"


def test_boxed_and_latex_math_vs_format() -> None:
    # Math wrappers allowed for mathematical correctness; format compliance separate.
    graded = grade_model_output(
        r"\boxed{ANSWER: \frac{9}{4}}",
        {"kind": "roots", "values": ["9/4"]},
        enable_thinking=False,
    )
    assert graded["outcome"] == "correct"
    assert graded["mathematicalCorrect"] is True
    assert graded["formatCompliant"] is False
    assert graded["graderVersion"] == GRADER_VERSION

    graded = grade_model_output(
        "ANSWER: 9/4",
        {"kind": "roots", "values": ["9/4"]},
        enable_thinking=False,
    )
    assert graded["outcome"] == "correct"
    assert graded["formatCompliant"] is True

    graded = grade_model_output(
        "$$ANSWER: \\frac{1}{2}$$",
        {"kind": "roots", "values": ["1/2"]},
        enable_thinking=False,
    )
    assert graded["outcome"] == "correct"
    assert graded["formatCompliant"] is False

    # Bare boxed expression without ANSWER: is not a final answer.
    graded = grade_model_output(
        r"\boxed{\frac{9}{4}}",
        {"kind": "roots", "values": ["9/4"]},
        enable_thinking=False,
    )
    assert graded["outcome"] == "invalid"
    assert graded["invalidReason"] == "no_answer_line"


def test_conflicting_and_missing() -> None:
    graded = grade_model_output(
        "ANSWER: 1\nANSWER: 2",
        {"kind": "roots", "values": ["1"]},
        enable_thinking=False,
    )
    assert graded["outcome"] == "invalid"
    assert graded["parsed"]["reason"] == "conflicting_answer_lines"

    graded = grade_model_output(
        "",
        {"kind": "roots", "values": ["1"]},
        enable_thinking=False,
    )
    assert graded["outcome"] == "invalid"


def test_grader_core() -> None:
    assert grade_answer("2, 1", {"kind": "roots", "values": ["1", "2"]})["correct"] is True
    assert grade_answer("no solution", {"kind": "no_solution"})["correct"] is True
    assert grade_answer("all real numbers", {"kind": "all_reals"})["correct"] is True
    assert grade_answer("(-oo, 3)", {"kind": "interval", "left": "-oo", "right": "3", "leftOpen": True, "rightOpen": True})["correct"] is True
    assert grade_answer("x + 1", {"kind": "expression", "value": "1 + x"})["correct"] is True
    assert grade_answer(r"(9)/(4)", {"kind": "roots", "values": ["9/4"]})["correct"] is True


def test_generation_slicing_and_sampling_kwargs() -> None:
    # Simulate left-padded row: pad pad real real | new new
    row = [0, 0, 10, 11, 20, 21]
    # Wrong approach used attention_mask.sum()==2 → would slice from index 2 (prompt contamination).
    wrong = row[2:]
    assert wrong == [10, 11, 20, 21]
    # Correct: padded width prompt_len=4
    prompt_len = prompt_token_length(4)
    got = slice_new_token_ids(row, prompt_len)
    assert list(got) == [20, 21]

    fields = {
        "maxNewTokens": 512,
        "doSample": True,
        "temperature": 0.6,
        "topP": 0.95,
        "topK": 20,
        "repetitionPenalty": 1.0,
    }
    kwargs = build_generate_kwargs(fields=fields, pad_token_id=0, eos_token_id=1)
    assert "generator" not in kwargs
    assert kwargs["do_sample"] is True
    assert kwargs["temperature"] == 0.6
    filtered = filter_unsupported_generate_kwargs({**kwargs, "generator": object()})
    assert "generator" not in filtered

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def manual_seed_all(_seed: int) -> None:
            raise AssertionError("should not be called")

    fake_torch = SimpleNamespace(manual_seed=lambda s: None, cuda=_Cuda())
    meta = apply_sampling_seed(fake_torch, 42, device="cpu")
    assert meta["generatorKwargUsed"] is False
    assert meta["seedApplied"] == 42


def test_answer_instruction_contract() -> None:
    assert "ANSWER: <mathematical expression>" in FINAL_ANSWER_INSTRUCTION
    # Item questions must remain unchanged; instruction is appended by eval only.
    from batched_eval import build_user_prompt

    item = {"prompt": "Solve for x.\n\nEquation: x = 1\n\nRef: abc"}
    built = build_user_prompt(item)
    assert item["prompt"] in built
    assert built.endswith(FINAL_ANSWER_INSTRUCTION) or FINAL_ANSWER_INSTRUCTION in built


def test_chat_template_boundary_contract() -> None:
    """Document expected Qwen3 thinking-disabled prompt boundary without downloading weights.

    The real template is verified on GPU via templateFingerprint. Locally we assert
    peft_chat passes enable_thinking through apply_chat_template.
    """
    sys.path.insert(0, str(ROOT.parent))
    from peft_chat import build_chat_texts

    calls: list[dict] = []

    class FakeTok:
        chat_template = "qwen3-fake"

        def apply_chat_template(self, messages, **kwargs):
            calls.append({"messages": messages, **kwargs})
            enable = kwargs.get("enable_thinking")
            if enable is False:
                return "<|im_start|>user\nQ<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n"
            return "<|im_start|>user\nQ<|im_end|>\n<|im_start|>assistant\n"

    prompt, _ = build_chat_texts(FakeTok(), "Q", None, enable_thinking=False)
    assert calls and calls[0]["enable_thinking"] is False
    assert calls[0]["add_generation_prompt"] is True
    # Thinking-disabled template includes empty think block in the *prompt*; generation
    # must start after it. Slicing bugs decode the closing tag as "new" tokens.
    assert prompt.endswith("</think>\n") or "</think>" in prompt

    calls.clear()
    prompt_on, _ = build_chat_texts(FakeTok(), "Q", None, enable_thinking=True)
    assert calls and calls[0]["enable_thinking"] is True
    assert "</think>" not in prompt_on or prompt_on.find("<think>") >= 0


def test_batch_invariance_metrics() -> None:
    # Left-pad: two pads + three content tokens → content positions 0,1,2
    mask = [0, 0, 1, 1, 1]
    pos = expected_left_pad_position_ids(mask)
    assert pos == [0, 0, 0, 1, 2]
    unpadded_mask = [1, 1, 1]
    unpadded_pos = expected_left_pad_position_ids(unpadded_mask)
    check = position_ids_aligned_with_unpadded(
        unpadded_attention_mask=unpadded_mask,
        unpadded_position_ids=unpadded_pos,
        padded_attention_mask=mask,
        padded_position_ids=pos,
    )
    assert check["aligned"] is True

    # Misaligned: padded row used arange over full width
    bad = position_ids_aligned_with_unpadded(
        unpadded_attention_mask=unpadded_mask,
        unpadded_position_ids=unpadded_pos,
        padded_attention_mask=mask,
        padded_position_ids=[0, 1, 2, 3, 4],
    )
    assert bad["aligned"] is False

    assert detect_prefix_artifacts("</think>\nWe solve...") == ["</think>"]
    assert detect_prefix_artifacts("assistant\nANSWER: 1") == ["assistant_role_prefix"]
    assert detect_prefix_artifacts("We solve...\nANSWER: 1") == []

    assert outcomes_agree(
        {"outcome": "correct", "mathText": "9/4"},
        {"outcome": "correct", "mathText": "9/4"},
    )
    assert not outcomes_agree(
        {"outcome": "correct", "mathText": "9/4"},
        {"outcome": "wrong", "mathText": "1"},
    )
    # Gate v2 preserved: hard logit band still fails large diffs.
    assert BF16_FIRST_TOKEN_LOGIT_ABS_TOL == 5e-2
    decision = gate_pass(
        prefix_artifact_count=0,
        position_ids_ok=True,
        outcome_disagreements=0,
        first_token_logit_max_abs=1e-2,
    )
    assert decision["passed"] is True
    assert decision["gateVersion"] == GATE_VERSION_V2
    fail = gate_pass(
        prefix_artifact_count=0,
        position_ids_ok=True,
        outcome_disagreements=0,
        first_token_logit_max_abs=0.2,
    )
    assert fail["passed"] is False

    # Equivalent LaTeX forms agree canonically (Gate v3); raw v2 outcomes_agree does not.
    assert answers_canonically_equal(r"1281/26", r"\frac{1281}{26}")["equal"] is True
    assert not outcomes_agree(
        {"outcome": "correct", "mathText": r"1281/26"},
        {"outcome": "correct", "mathText": r"\frac{1281}{26}"},
    )
    # Distinct wrong answers must not collapse just because both are wrong.
    assert answers_canonically_equal("1", "2")["equal"] is False

    logits_p = [2.0, 0.0, -1.0]
    logits_q = [2.1, -0.1, -0.9]
    diag = first_token_diagnostics(logits_p, logits_q)
    assert diag["top1Agree"] is True
    assert diag["klAB"] >= 0.0
    assert kl_divergence_f32(logits_p, logits_p) < 1e-12

    v3_pass = gate_pass_v3(
        prefix_artifact_count=0,
        position_ids_ok=True,
        graded_outcome_disagreements=0,
        canonical_answer_disagreements=0,
        repeatability_passed=True,
    )
    assert v3_pass["passed"] is True
    assert v3_pass["gateVersion"] == GATE_VERSION_V3
    assert v3_pass["logitThresholdUsedForAcceptance"] is None
    v3_fail = gate_pass_v3(
        prefix_artifact_count=0,
        position_ids_ok=True,
        graded_outcome_disagreements=0,
        canonical_answer_disagreements=1,
        repeatability_passed=True,
    )
    assert v3_fail["passed"] is False

    assert BATCHING_POLICY["baseAndAdapterIdenticalBatching"] is True
    assert BATCHING_POLICY["batchInvarianceGateVersion"] == GATE_VERSION_V3
    assert EVAL_IMPLEMENTATION_VERSION == "c18d1-batched-eval-v4"


def test_transformers_523_sampling_compat_source() -> None:
    source = (ROOT / "batched_eval.py").read_text(encoding="utf-8")
    # Must not assign a torch Generator into generate kwargs (TF 5.23 rejects it).
    assert '["generator"]' not in source
    assert "torch.Generator" not in source
    kwargs = build_generate_kwargs(
        fields={
            "maxNewTokens": 16,
            "doSample": True,
            "temperature": 0.6,
            "topP": 0.95,
            "topK": 20,
            "repetitionPenalty": 1.0,
        },
        pad_token_id=0,
        eos_token_id=1,
    )
    assert "generator" not in kwargs
    assert "generator" not in filter_unsupported_generate_kwargs({"generator": object(), **kwargs})
    utils_src = (ROOT / "generation_utils.py").read_text(encoding="utf-8")
    assert "filter_unsupported_generate_kwargs" in utils_src
    assert "banned" in utils_src or "Never passes" in utils_src


def test_access_control() -> None:
    assert can_read_locked_items(role="evaluation") is True
    assert can_read_locked_items(role="math") is False
    assert can_read_locked_items(department_id="00000000-0000-4000-8000-000000000015") is False
    try:
        assert_can_read_locked_items(role="weight_optimization")
        raise AssertionError("weight must be denied")
    except LockedTestAccessError:
        pass


def test_dataset_minimums_public() -> None:
    manifest = json.loads((ROOT / "datasets" / "manifests" / "benchmark_manifest.json").read_text())
    assert manifest["benchmarkVersion"] == "c18d1-algebra-v2"
    assert manifest["counts"]["development"] >= 500
    assert manifest["counts"]["regression"] >= 120
    assert manifest["retiredLocked"]["status"] == "retired"
    assert manifest["splits"]["locked_id"]["status"] == "external_only"
    assert len(manifest["splits"]["development"]["families"]) == 10


def test_no_locked_files_tracked_by_git() -> None:
    result = subprocess.run(
        ["git", "ls-files", "services/training/cuda/c18d1/datasets/locked"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    tracked = [line for line in result.stdout.splitlines() if line.strip()]
    assert tracked == [], f"Locked data must not be tracked by git: {tracked}"


def test_prompts_have_no_split_identity() -> None:
    for rel in ("datasets/dev/id_dev.jsonl", "datasets/regression/regression.jsonl"):
        path = ROOT / rel
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            assert not prompt_leaks_split_identity(item["prompt"]), item["id"]
            assert "Instance:" not in item["prompt"]


def test_locked_generator_refuses_without_external_seed() -> None:
    saved = {
        key: os.environ.pop(key, None)
        for key in ("C18D1_LOCKED_SEED_FILE", "C18D1_LOCKED_SEED_ID", "C18D1_LOCKED_SEED_OOD")
    }
    try:
        try:
            load_locked_stream_seeds()
            raise AssertionError("expected LockedSeedError without external seeds")
        except LockedSeedError:
            pass
    finally:
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value


def main() -> None:
    test_revisions()
    test_parser_adversarial()
    test_unexpected_think_and_no_answer()
    test_boxed_and_latex_math_vs_format()
    test_conflicting_and_missing()
    test_grader_core()
    test_generation_slicing_and_sampling_kwargs()
    test_answer_instruction_contract()
    test_chat_template_boundary_contract()
    test_batch_invariance_metrics()
    test_transformers_523_sampling_compat_source()
    test_access_control()
    test_dataset_minimums_public()
    test_no_locked_files_tracked_by_git()
    test_prompts_have_no_split_identity()
    test_locked_generator_refuses_without_external_seed()
    print("c18d1 local tests ok")


if __name__ == "__main__":
    main()
