#!/usr/bin/env python3
"""Final-answer parser for C1.8D.1 Math evaluation (grader v3.1).

Never search the reasoning trace. Only the final response region
(after ``</think>`` when thinking is enabled) is considered.

Accepted final-answer markers (v3):
- a bare ``ANSWER: <expr>`` line, or
- the **last** ``\\boxed{...}`` in the final region

If both are present and canonically disagree → invalid.
Format compliance remains the bare ``ANSWER:`` contract and is reported
separately from mathematical correctness (including which marker was used).
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

GRADER_VERSION = "c18d1-grader-v3.1"
THINK_CLOSE = "</think>"
THINK_OPEN = "<think>"

STRICT_ANSWER_LINE = re.compile(r"(?im)^\s*ANSWER:\s*(.+?)\s*$")
ANSWER_TOKEN = re.compile(r"(?i)ANSWER:\s*(.+)$")
BOXED_START = re.compile(r"\\boxed\s*\{")


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
        if text.startswith("\\boxed"):
            inner = _extract_boxed_at(text, 0)
            if inner is not None:
                text = inner.strip()
                applied.append("\\boxed")
                changed = True
    return text, applied


def _extract_boxed_at(text: str, start: int) -> str | None:
    """Extract balanced ``\\boxed{...}`` content starting at ``start`` (at \\boxed)."""
    match = BOXED_START.match(text, start)
    if not match:
        return None
    i = match.end()
    depth = 1
    out: list[str] = []
    while i < len(text) and depth > 0:
        ch = text[i]
        if ch == "{":
            depth += 1
            out.append(ch)
        elif ch == "}":
            depth -= 1
            if depth > 0:
                out.append(ch)
        else:
            out.append(ch)
        i += 1
    if depth != 0:
        return None
    return "".join(out)


def extract_all_boxed(final_text: str) -> list[str]:
    """Return contents of every balanced ``\\boxed{...}`` in the final region only."""
    text = final_text or ""
    found: list[str] = []
    for match in BOXED_START.finditer(text):
        inner = _extract_boxed_at(text, match.start())
        if inner is not None:
            found.append(inner.strip())
    return found


def _payload_from_boxed_inner(inner: str) -> tuple[str, list[str], str]:
    """Return (math_text, wrappers, source) from boxed inner content."""
    ans = ANSWER_TOKEN.search(inner)
    if ans:
        math_text, extra = _strip_math_wrappers(ans.group(1).strip())
        return math_text, ["\\boxed", *extra], "boxed_answer_token"
    math_text, extra = _strip_math_wrappers(inner)
    return math_text, ["\\boxed", *extra], "boxed_expression"


def _answer_lines(final_text: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for line in (final_text or "").splitlines():
        strict = STRICT_ANSWER_LINE.match(line)
        if not strict:
            continue
        payload = strict.group(1).strip()
        math_text, wrappers = _strip_math_wrappers(payload)
        found.append(
            {
                "rawLine": line.strip(),
                "payload": payload,
                "mathText": math_text,
                "wrappers": wrappers,
                "strictFormat": len(wrappers) == 0 and bool(math_text),
                "source": "strict_answer_line",
            },
        )
    return found


def _canonically_equal(a: str | None, b: str | None) -> bool:
    from sympy_grader import answers_canonically_equal

    return bool(answers_canonically_equal(a, b)["equal"])


def parse_answer_lines(final_text: str) -> dict[str, Any]:
    """Parse final-answer markers from the final (post-think) text only."""
    answer_lines = _answer_lines(final_text)
    boxed_list = extract_all_boxed(final_text)
    boxed_cand = None
    if boxed_list:
        inner = boxed_list[-1]  # last boxed in final region only
        math_text, wrappers, source = _payload_from_boxed_inner(inner)
        boxed_cand = {
            "rawLine": f"\\boxed{{{inner}}}",
            "payload": inner,
            "mathText": math_text,
            "wrappers": wrappers,
            "strictFormat": False,
            "source": source,
        }

    # Conflicting ANSWER lines among themselves → invalid (never pick the lucky one).
    if answer_lines:
        unique_answers = list(dict.fromkeys(c["mathText"] for c in answer_lines if c.get("mathText")))
        if len(unique_answers) > 1:
            return {
                "status": "ambiguous",
                "answers": unique_answers,
                "selected": None,
                "mathText": None,
                "strictFormat": False,
                "formatCompliant": False,
                "answerMarkerUsed": "conflict",
                "reason": "conflicting_answer_lines",
                "candidates": answer_lines + ([boxed_cand] if boxed_cand else []),
            }
        answer_cand = answer_lines[-1]
    else:
        answer_cand = None

    candidates = [c for c in (answer_cand, boxed_cand) if c is not None]

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
                "answerMarkerUsed": None,
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
            "answerMarkerUsed": None,
            "reason": "no_answer_marker",
            "finalTextPreview": stripped[:200],
            "candidates": [],
        }

    if answer_cand and boxed_cand:
        if not _canonically_equal(answer_cand["mathText"], boxed_cand["mathText"]):
            return {
                "status": "ambiguous",
                "answers": [answer_cand["mathText"], boxed_cand["mathText"]],
                "selected": None,
                "mathText": None,
                "strictFormat": False,
                "formatCompliant": False,
                "answerMarkerUsed": "conflict",
                "reason": "conflicting_answer_and_boxed",
                "candidates": candidates,
            }
        # Agree: prefer ANSWER text for display; marker = both_agree
        chosen = answer_cand
        marker = "both_agree"
    elif answer_cand:
        chosen = answer_cand
        marker = "answer_line"
    else:
        chosen = boxed_cand  # type: ignore[assignment]
        marker = "boxed"

    if not chosen.get("mathText"):
        return {
            "status": "malformed",
            "answers": [""],
            "selected": None,
            "mathText": None,
            "strictFormat": False,
            "formatCompliant": False,
            "answerMarkerUsed": marker,
            "reason": "empty_answer_payload",
            "candidates": candidates,
        }

    format_compliant = bool(
        answer_cand
        and answer_cand.get("strictFormat")
        and answer_cand.get("source") == "strict_answer_line"
        and not (answer_cand.get("wrappers")),
    )
    return {
        "status": "ok",
        "answers": [chosen["mathText"]],
        "selected": chosen["mathText"],
        "mathText": chosen["mathText"],
        "strictFormat": bool(chosen.get("strictFormat")),
        "formatCompliant": format_compliant,
        "answerMarkerUsed": marker,
        "reason": None,
        "candidates": candidates,
        "wrappers": chosen.get("wrappers") or [],
        "boxedCountInFinal": len(boxed_list),
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
            "answerMarkerUsed": None,
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
            "answerMarkerUsed": None,
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
            "answerMarkerUsed": parsed.get("answerMarkerUsed"),
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
        "answerMarkerUsed": parsed.get("answerMarkerUsed"),
        "wrappers": parsed.get("wrappers") or [],
        "candidates": parsed.get("candidates") or [],
        "graderVersion": GRADER_VERSION,
    }
