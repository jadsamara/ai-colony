#!/usr/bin/env python3
"""Strict ANSWER: parser for C1.8D.1 Math evaluation.

Never search the reasoning trace for a correct answer when the final answer
is missing. Never silently pick whichever of several answers matches expected.
"""

from __future__ import annotations

import re
from typing import Any, Literal

ParseStatus = Literal["ok", "missing", "ambiguous", "malformed", "truncated_think", "empty"]

ANSWER_LINE = re.compile(r"(?im)^\s*ANSWER:\s*(.+?)\s*$")
THINK_CLOSE = "</think>"


def extract_after_thinking(raw: str, *, enable_thinking: bool) -> dict[str, Any]:
    text = raw or ""
    if not enable_thinking:
        if "<think>" in text or THINK_CLOSE in text:
            return {
                "finalText": "",
                "status": "malformed",
                "reason": "unexpected_think_with_thinking_disabled",
                "hadThinkClose": THINK_CLOSE in text,
            }
        return {"finalText": text, "status": "ok", "reason": None, "hadThinkClose": False}

    if THINK_CLOSE not in text:
        return {
            "finalText": "",
            "status": "truncated_think",
            "reason": "unclosed_or_missing_think_block",
            "hadThinkClose": False,
        }
    final = text.rsplit(THINK_CLOSE, 1)[1]
    return {
        "finalText": final,
        "status": "ok",
        "reason": None,
        "hadThinkClose": True,
    }


def parse_answer_lines(final_text: str) -> dict[str, Any]:
    """Parse ANSWER: lines from the final (post-think) text only."""
    lines = ANSWER_LINE.findall(final_text or "")
    if not lines:
        # Do NOT fall back to scanning reasoning or substring search.
        stripped = (final_text or "").strip()
        if not stripped:
            return {
                "status": "empty",
                "answers": [],
                "selected": None,
                "reason": "empty_final_text",
            }
        return {
            "status": "missing",
            "answers": [],
            "selected": None,
            "reason": "no_answer_line",
            "finalTextPreview": stripped[:200],
        }
    if len(lines) > 1:
        unique = list(dict.fromkeys(line.strip() for line in lines))
        if len(unique) > 1:
            return {
                "status": "ambiguous",
                "answers": unique,
                "selected": None,
                "reason": "conflicting_answer_lines",
            }
        # Identical repeated ANSWER lines are accepted once.
        return {
            "status": "ok",
            "answers": unique,
            "selected": unique[0],
            "reason": "duplicate_identical_answer_lines",
        }
    selected = lines[0].strip()
    if not selected:
        return {
            "status": "malformed",
            "answers": [""],
            "selected": None,
            "reason": "empty_answer_payload",
        }
    return {
        "status": "ok",
        "answers": [selected],
        "selected": selected,
        "reason": None,
    }


def parse_model_output(raw: str, *, enable_thinking: bool, truncated: bool = False) -> dict[str, Any]:
    think = extract_after_thinking(raw, enable_thinking=enable_thinking)
    if think["status"] != "ok":
        return {
            "ok": False,
            "outcomeClass": "invalid",
            "parseStatus": think["status"],
            "answer": None,
            "answers": [],
            "truncated": truncated or think["status"] == "truncated_think",
            "reason": think["reason"],
            "finalText": think.get("finalText") or "",
        }
    if truncated and not (think.get("finalText") or "").strip():
        return {
            "ok": False,
            "outcomeClass": "truncated",
            "parseStatus": "missing",
            "answer": None,
            "answers": [],
            "truncated": True,
            "reason": "truncated_before_final_answer",
            "finalText": "",
        }
    parsed = parse_answer_lines(str(think["finalText"]))
    if parsed["status"] != "ok":
        outcome = "truncated" if truncated and parsed["status"] in {"missing", "empty"} else "invalid"
        return {
            "ok": False,
            "outcomeClass": outcome,
            "parseStatus": parsed["status"],
            "answer": None,
            "answers": parsed.get("answers") or [],
            "truncated": truncated,
            "reason": parsed.get("reason"),
            "finalText": think["finalText"],
        }
    return {
        "ok": True,
        "outcomeClass": "parsed",
        "parseStatus": "ok",
        "answer": parsed["selected"],
        "answers": parsed["answers"],
        "truncated": truncated,
        "reason": parsed.get("reason"),
        "finalText": think["finalText"],
    }
