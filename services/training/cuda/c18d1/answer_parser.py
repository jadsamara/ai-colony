#!/usr/bin/env python3
"""Strict final-answer parser for C1.8D.1 Math evaluation (grader v2).

Never search the reasoning trace for a correct answer when the final answer
is missing. Never silently pick whichever of several answers matches expected.

Mathematical extraction may unwrap narrowly allowed wrappers around an
``ANSWER:`` payload. Format compliance requires a bare ``ANSWER:`` line.
"""

from __future__ import annotations

import re
from typing import Any, Literal

ParseStatus = Literal[
    "ok",
    "missing",
    "ambiguous",
    "malformed",
    "truncated_think",
    "empty",
    "protocol_violation",
]

GRADER_VERSION = "c18d1-grader-v2"
THINK_CLOSE = "</think>"
THINK_OPEN = "<think>"

STRICT_ANSWER_LINE = re.compile(r"(?im)^\s*ANSWER:\s*(.+?)\s*$")
ANSWER_TOKEN = re.compile(r"(?i)ANSWER:\s*(.+)$")


def extract_after_thinking(raw: str, *, enable_thinking: bool) -> dict[str, Any]:
    text = raw or ""
    if not enable_thinking:
        if THINK_OPEN in text or THINK_CLOSE in text:
            return {
                "finalText": "",
                "status": "protocol_violation",
                "reason": "unexpected_think_with_thinking_disabled",
                "hadThinkClose": THINK_CLOSE in text,
                "thinkingProtocolViolation": True,
            }
        return {
            "finalText": text,
            "status": "ok",
            "reason": None,
            "hadThinkClose": False,
            "thinkingProtocolViolation": False,
        }

    if THINK_CLOSE not in text:
        return {
            "finalText": "",
            "status": "truncated_think",
            "reason": "unclosed_or_missing_think_block",
            "hadThinkClose": False,
            "thinkingProtocolViolation": False,
        }
    final = text.rsplit(THINK_CLOSE, 1)[1]
    return {
        "finalText": final,
        "status": "ok",
        "reason": None,
        "hadThinkClose": True,
        "thinkingProtocolViolation": False,
    }


def _strip_math_wrappers(payload: str) -> tuple[str, list[str]]:
    """Remove narrowly allowed math wrappers; return (inner, wrappers_applied)."""
    text = (payload or "").strip()
    applied: list[str] = []
    changed = True
    while changed and text:
        changed = False
        for pattern, name in (
            (r"^\$\$(.*)\$\$$", "$$"),
            (r"^\$(.*)\$$", "$"),
            (r"^\\\[(.*)\\\]$", "\\[\\]"),
            (r"^\\\((.*)\\\)$", "\\(\\)"),
        ):
            match = re.match(pattern, text, flags=re.DOTALL)
            if match:
                text = match.group(1).strip()
                applied.append(name)
                changed = True
                break
        boxed = re.match(r"^\\boxed\s*\{(.*)\}\s*$", text, flags=re.DOTALL)
        if boxed:
            text = boxed.group(1).strip()
            applied.append("\\boxed")
            changed = True
    return text, applied


def _candidate_from_answer_payload(
    *,
    raw_line: str,
    payload: str,
    wrappers: list[str],
    source: str,
) -> dict[str, Any]:
    inner, extra = _strip_math_wrappers(payload)
    all_wrappers = [*wrappers, *extra]
    return {
        "rawLine": raw_line,
        "payload": payload,
        "mathText": inner,
        "wrappers": all_wrappers,
        "strictFormat": len(all_wrappers) == 0 and bool(inner),
        "source": source,
    }


def _candidate_answer_strings(final_text: str) -> list[dict[str, Any]]:
    """Collect final-answer candidates that contain an ANSWER: token.

    Only the final (post-think) region is scanned. Bare boxed expressions
    without ANSWER: are not accepted — that would interpret non-contract text.
    """
    candidates: list[dict[str, Any]] = []
    for line in (final_text or "").splitlines():
        strict = STRICT_ANSWER_LINE.match(line)
        if strict:
            candidates.append(
                _candidate_from_answer_payload(
                    raw_line=line.strip(),
                    payload=strict.group(1).strip(),
                    wrappers=[],
                    source="strict_answer_line",
                ),
            )
            continue

        stripped = line.strip()
        boxed = re.match(r"^\\boxed\s*\{(.*)\}\s*$", stripped, flags=re.DOTALL)
        if boxed:
            inner = boxed.group(1).strip()
            ans = ANSWER_TOKEN.search(inner)
            if ans:
                candidates.append(
                    _candidate_from_answer_payload(
                        raw_line=stripped,
                        payload=ans.group(1).strip(),
                        wrappers=["\\boxed"],
                        source="boxed_answer_token",
                    ),
                )
            continue

        for pattern, wrapper_name, source in (
            (r"^\$\$(.*)\$\$$", "$$", "dollar_answer_token"),
            (r"^\\\[(.*)\\\]$", "\\[\\]", "bracket_answer_token"),
        ):
            match = re.match(pattern, stripped, flags=re.DOTALL)
            if not match:
                continue
            inner = match.group(1).strip()
            ans = ANSWER_TOKEN.search(inner)
            if ans:
                candidates.append(
                    _candidate_from_answer_payload(
                        raw_line=stripped,
                        payload=ans.group(1).strip(),
                        wrappers=[wrapper_name],
                        source=source,
                    ),
                )
            break
    return candidates


def _is_format_compliant(candidates: list[dict[str, Any]]) -> bool:
    """Exact contract: one or more identical bare ANSWER lines, no wrappers."""
    if not candidates:
        return False
    if any(c.get("wrappers") for c in candidates):
        return False
    if not all(c.get("source") == "strict_answer_line" and c.get("strictFormat") for c in candidates):
        return False
    math_values = [c["mathText"] for c in candidates]
    return len(set(math_values)) == 1


def parse_answer_lines(final_text: str) -> dict[str, Any]:
    """Parse final-answer candidates from the final (post-think) text only."""
    candidates = _candidate_answer_strings(final_text)
    if not candidates:
        stripped = (final_text or "").strip()
        if not stripped:
            return {
                "status": "empty",
                "answers": [],
                "selected": None,
                "mathText": None,
                "strictFormat": False,
                "formatCompliant": False,
                "reason": "empty_final_text",
                "candidates": [],
            }
        return {
            "status": "missing",
            "answers": [],
            "selected": None,
            "mathText": None,
            "strictFormat": False,
            "formatCompliant": False,
            "reason": "no_answer_line",
            "finalTextPreview": stripped[:200],
            "candidates": [],
        }

    math_values = [c["mathText"] for c in candidates if c.get("mathText")]
    unique_math = list(dict.fromkeys(math_values))
    if len(unique_math) > 1:
        return {
            "status": "ambiguous",
            "answers": unique_math,
            "selected": None,
            "mathText": None,
            "strictFormat": False,
            "formatCompliant": False,
            "reason": "conflicting_answer_lines",
            "candidates": candidates,
        }

    chosen = candidates[-1]
    if not chosen.get("mathText"):
        return {
            "status": "malformed",
            "answers": [""],
            "selected": None,
            "mathText": None,
            "strictFormat": False,
            "formatCompliant": False,
            "reason": "empty_answer_payload",
            "candidates": candidates,
        }
    return {
        "status": "ok",
        "answers": unique_math,
        "selected": chosen["mathText"],
        "mathText": chosen["mathText"],
        "strictFormat": bool(chosen.get("strictFormat")),
        "formatCompliant": _is_format_compliant(candidates),
        "reason": None if len(candidates) == 1 else "multiple_identical_math_answers",
        "candidates": candidates,
        "wrappers": chosen.get("wrappers") or [],
    }


def parse_model_output(raw: str, *, enable_thinking: bool, truncated: bool = False) -> dict[str, Any]:
    think = extract_after_thinking(raw, enable_thinking=enable_thinking)
    if think["status"] != "ok":
        outcome = "truncated" if think["status"] == "truncated_think" and truncated else "invalid"
        return {
            "ok": False,
            "outcomeClass": outcome,
            "parseStatus": think["status"],
            "answer": None,
            "mathText": None,
            "answers": [],
            "truncated": truncated or think["status"] == "truncated_think",
            "reason": think["reason"],
            "finalText": think.get("finalText") or "",
            "thinkingProtocolViolation": bool(think.get("thinkingProtocolViolation")),
            "formatCompliant": False,
            "graderVersion": GRADER_VERSION,
        }
    if truncated and not (think.get("finalText") or "").strip():
        return {
            "ok": False,
            "outcomeClass": "truncated",
            "parseStatus": "missing",
            "answer": None,
            "mathText": None,
            "answers": [],
            "truncated": True,
            "reason": "truncated_before_final_answer",
            "finalText": "",
            "thinkingProtocolViolation": False,
            "formatCompliant": False,
            "graderVersion": GRADER_VERSION,
        }
    parsed = parse_answer_lines(str(think["finalText"]))
    if parsed["status"] != "ok":
        outcome = "truncated" if truncated and parsed["status"] in {"missing", "empty"} else "invalid"
        return {
            "ok": False,
            "outcomeClass": outcome,
            "parseStatus": parsed["status"],
            "answer": None,
            "mathText": None,
            "answers": parsed.get("answers") or [],
            "truncated": truncated,
            "reason": parsed.get("reason"),
            "finalText": think["finalText"],
            "thinkingProtocolViolation": False,
            "formatCompliant": False,
            "candidates": parsed.get("candidates") or [],
            "graderVersion": GRADER_VERSION,
        }
    return {
        "ok": True,
        "outcomeClass": "parsed",
        "parseStatus": "ok",
        "answer": parsed["mathText"],
        "mathText": parsed["mathText"],
        "answers": parsed["answers"],
        "truncated": truncated,
        "reason": parsed.get("reason"),
        "finalText": think["finalText"],
        "thinkingProtocolViolation": False,
        "formatCompliant": bool(parsed.get("formatCompliant")),
        "wrappers": parsed.get("wrappers") or [],
        "candidates": parsed.get("candidates") or [],
        "graderVersion": GRADER_VERSION,
    }
