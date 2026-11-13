#!/usr/bin/env python3
"""Deterministic SymPy grading for C1.8D.1 algebra families.

LLM judges are forbidden as the sole source of correctness.
"""

from __future__ import annotations

import re
from typing import Any

import sympy as sp
from sympy.parsing.sympy_parser import (
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

from answer_parser import parse_model_output

TRANSFORMS = standard_transformations + (implicit_multiplication_application,)

NO_SOLUTION_TOKENS = {
    "no solution",
    "none",
    "∅",
    "emptyset",
    "empty set",
    "no real solution",
    "no real solutions",
}
ALL_REALS_TOKENS = {
    "all real numbers",
    "all reals",
    "ℝ",
    "r",
    "(-oo, oo)",
    "(-∞, ∞)",
}


def _normalize_text(text: str) -> str:
    t = (text or "").strip()
    t = t.replace("\\infty", "oo").replace("∞", "oo")
    t = t.replace("\\cup", "U").replace("∪", "U")
    t = re.sub(r"\s+", " ", t)
    return t


def _parse_expr(text: str, local_dict: dict[str, Any] | None = None) -> sp.Expr:
    cleaned = _normalize_text(text)
    cleaned = cleaned.replace("^", "**")
    cleaned = cleaned.replace("\\left", "").replace("\\right", "")
    cleaned = cleaned.replace("$", "")
    return parse_expr(cleaned, local_dict=local_dict or {"x": sp.Symbol("x")}, transformations=TRANSFORMS)


def _split_root_list(text: str) -> list[str]:
    cleaned = _normalize_text(text)
    if cleaned.startswith("{") and cleaned.endswith("}"):
        cleaned = cleaned[1:-1]
    if not cleaned:
        return []
    parts: list[str] = []
    depth = 0
    current = []
    for ch in cleaned:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
            continue
        current.append(ch)
    if current:
        parts.append("".join(current).strip())
    return [p for p in parts if p]


def parse_expected(expected: dict[str, Any]) -> dict[str, Any]:
    kind = expected["kind"]
    if kind == "roots":
        roots = [_parse_expr(str(r)) for r in expected["values"]]
        return {"kind": "roots", "roots": roots, "variable": expected.get("variable", "x")}
    if kind == "no_solution":
        return {"kind": "no_solution"}
    if kind == "all_reals":
        return {"kind": "all_reals"}
    if kind == "interval":
        return {
            "kind": "interval",
            "interval": sp.Interval(
                _parse_expr(str(expected["left"])) if expected["left"] not in {"-oo", "-∞"} else -sp.oo,
                _parse_expr(str(expected["right"])) if expected["right"] not in {"oo", "∞"} else sp.oo,
                left_open=bool(expected.get("leftOpen", False)),
                right_open=bool(expected.get("rightOpen", False)),
            ),
        }
    if kind == "expression":
        return {"kind": "expression", "expr": _parse_expr(str(expected["value"]))}
    if kind == "relation":
        return {"kind": "relation", "expr": _parse_expr(str(expected["value"]))}
    raise ValueError(f"Unknown expected kind: {kind}")


def _as_root_set(text: str) -> set[sp.Expr] | None:
    low = _normalize_text(text).lower()
    if low in NO_SOLUTION_TOKENS:
        return set()
    parts = _split_root_list(text)
    roots: set[sp.Expr] = set()
    for part in parts:
        try:
            roots.add(sp.simplify(_parse_expr(part)))
        except Exception:
            return None
    return roots


def _expr_equal(a: sp.Expr, b: sp.Expr) -> bool:
    try:
        diff = sp.simplify(sp.expand(a - b))
        if diff == 0:
            return True
    except Exception:
        pass
    try:
        return bool(sp.Eq(sp.simplify(a), sp.simplify(b)))
    except Exception:
        return False


def grade_answer(answer_text: str, expected: dict[str, Any]) -> dict[str, Any]:
    exp = parse_expected(expected)
    text = _normalize_text(answer_text)
    low = text.lower()

    if exp["kind"] == "no_solution":
        ok = low in NO_SOLUTION_TOKENS or text in {"{}", "∅"}
        return {"correct": ok, "detail": "no_solution"}

    if exp["kind"] == "all_reals":
        ok = low in ALL_REALS_TOKENS or text in {"(-oo, oo)", "R"}
        return {"correct": ok, "detail": "all_reals"}

    if exp["kind"] == "roots":
        got = _as_root_set(text)
        if got is None:
            return {"correct": False, "detail": "unparseable_roots"}
        want = {sp.simplify(r) for r in exp["roots"]}
        # Order-independent; multiplicity collapsed to set equality unless specified.
        if expected.get("multiset"):
            # Compare sorted simplified strings as a stable multiset proxy.
            want_m = sorted(str(sp.simplify(r)) for r in exp["roots"])
            got_parts = _split_root_list(text)
            try:
                got_m = sorted(str(sp.simplify(_parse_expr(p))) for p in got_parts)
            except Exception:
                return {"correct": False, "detail": "unparseable_roots"}
            return {"correct": want_m == got_m, "detail": "multiset_roots"}
        # Match by pairwise algebraic equality.
        unmatched = list(want)
        for g in list(got):
            hit = None
            for w in unmatched:
                if _expr_equal(g, w):
                    hit = w
                    break
            if hit is None:
                return {"correct": False, "detail": "extra_or_wrong_root", "got": [str(x) for x in got]}
            unmatched.remove(hit)
        return {"correct": len(unmatched) == 0 and len(got) == len(want), "detail": "roots"}

    if exp["kind"] == "expression":
        try:
            got = _parse_expr(text)
        except Exception:
            return {"correct": False, "detail": "unparseable_expression"}
        return {"correct": _expr_equal(got, exp["expr"]), "detail": "expression"}

    if exp["kind"] == "interval":
        # Accept interval notation or inequality shorthand via SymPy sets when possible.
        try:
            if text.startswith("(") or text.startswith("["):
                inner = text.strip()
                left_open = inner[0] == "("
                right_open = inner[-1] == ")"
                body = inner[1:-1]
                left_s, right_s = [p.strip() for p in body.split(",", 1)]
                left = -sp.oo if left_s in {"-oo", "-∞"} else _parse_expr(left_s)
                right = sp.oo if right_s in {"oo", "∞"} else _parse_expr(right_s)
                got = sp.Interval(left, right, left_open=left_open, right_open=right_open)
                return {"correct": got == exp["interval"], "detail": "interval"}
        except Exception:
            return {"correct": False, "detail": "unparseable_interval"}
        return {"correct": False, "detail": "interval_format"}

    if exp["kind"] == "relation":
        try:
            got = _parse_expr(text)
            return {"correct": _expr_equal(got, exp["expr"]), "detail": "relation"}
        except Exception:
            return {"correct": False, "detail": "unparseable_relation"}

    return {"correct": False, "detail": "unsupported"}


def grade_model_output(
    raw: str,
    expected: dict[str, Any],
    *,
    enable_thinking: bool,
    truncated: bool = False,
) -> dict[str, Any]:
    parsed = parse_model_output(raw, enable_thinking=enable_thinking, truncated=truncated)
    if not parsed["ok"]:
        outcome = parsed["outcomeClass"]
        if outcome == "truncated":
            label = "truncated"
        else:
            label = "invalid"
        return {
            "outcome": label,
            "correct": False,
            "parsed": parsed,
            "grade": None,
        }
    grade = grade_answer(str(parsed["answer"]), expected)
    return {
        "outcome": "correct" if grade["correct"] else "wrong",
        "correct": bool(grade["correct"]),
        "parsed": parsed,
        "grade": grade,
    }
