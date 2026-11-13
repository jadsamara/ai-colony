#!/usr/bin/env python3
"""Local (CPU) unit tests for C1.8D.1 — no GPU required."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from access_control import LockedTestAccessError, assert_can_read_locked_items, can_read_locked_items
from answer_parser import parse_model_output
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
    # Correct in reasoning only — must NOT count.
    raw = "<think>The answer is 4</think>\nI am unsure."
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is False
    assert parsed["outcomeClass"] == "invalid"

    # Conflicting ANSWER lines
    raw = "<think>x</think>\nANSWER: 1\nANSWER: 2"
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is False
    assert parsed["parseStatus"] == "ambiguous"

    # Malformed / prose without ANSWER
    raw = "<think></think>\nThe solution is clearly 7."
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is False

    # LaTeX-ish equivalent handled at grader; parser accepts payload
    raw = "<think></think>\nANSWER: \\frac{1}{2}"
    parsed = parse_model_output(raw, enable_thinking=True)
    assert parsed["ok"] is True

    # Substring trap: invalid answer containing expected text
    graded = grade_model_output(
        "<think></think>\nANSWER: not 4 but nearby",
        {"kind": "roots", "values": ["4"]},
        enable_thinking=True,
    )
    assert graded["outcome"] == "wrong"

    # Truncated unclosed think
    parsed = parse_model_output("<think>still thinking", enable_thinking=True, truncated=True)
    assert parsed["outcomeClass"] in {"invalid", "truncated"}
    assert parsed["ok"] is False

    # Missing final answer
    parsed = parse_model_output("<think>done</think>\n", enable_thinking=True)
    assert parsed["ok"] is False

    # Thinking disabled must not contain think tags
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


def test_dataset_minimums() -> None:
    manifest = json.loads((ROOT / "datasets" / "manifests" / "benchmark_manifest.json").read_text())
    assert manifest["counts"]["development"] >= 500
    assert manifest["counts"]["locked_id"] >= 1000
    assert manifest["counts"]["locked_ood"] >= 300
    assert len(manifest["splits"]["development"]["families"]) == 10
    assert len(manifest["splits"]["locked_ood"]["families"]) == 3
    audit = json.loads((ROOT / "datasets" / "manifests" / "overlap_audit.json").read_text())
    assert audit["ok"] is True


def main() -> None:
    test_revisions()
    test_parser_adversarial()
    test_grader_core()
    test_access_control()
    test_dataset_minimums()
    print("c18d1 local tests ok")


if __name__ == "__main__":
    main()
