#!/usr/bin/env python3
"""Local (CPU) unit tests for C1.8D.1 — no GPU required."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[3]
sys.path.insert(0, str(ROOT))

from access_control import LockedTestAccessError, assert_can_read_locked_items, can_read_locked_items
from answer_parser import parse_model_output
from generators import prompt_leaks_split_identity
from locked_seeds import LockedSeedError, load_locked_stream_seeds
from revisions import assert_commit_hash, is_commit_hash, require_for_baseline, verify_pinned
from sympy_grader import grade_answer, grade_model_output


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

    raw = "<think></think>\nANSWER: \\frac{1}{2}"
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is True

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


def test_grader_core() -> None:
    assert grade_answer("2, 1", {"kind": "roots", "values": ["1", "2"]})["correct"] is True
    assert grade_answer("no solution", {"kind": "no_solution"})["correct"] is True
    assert grade_answer("all real numbers", {"kind": "all_reals"})["correct"] is True
    assert grade_answer("(-oo, 3)", {"kind": "interval", "left": "-oo", "right": "3", "leftOpen": True, "rightOpen": True})["correct"] is True
    assert grade_answer("x + 1", {"kind": "expression", "value": "1 + x"})["correct"] is True


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
    test_grader_core()
    test_access_control()
    test_dataset_minimums_public()
    test_no_locked_files_tracked_by_git()
    test_prompts_have_no_split_identity()
    test_locked_generator_refuses_without_external_seed()
    print("c18d1 local tests ok")


if __name__ == "__main__":
    main()
