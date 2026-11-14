#!/usr/bin/env python3
"""Deterministic SymPy grading for C1.8D.1 algebra (grader v3.3).

Separates mathematical accuracy from format compliance.
LLM judges are forbidden as the sole source of correctness.

v3.1: interval endpoints compare via symbolic equality (Float −0.5 ≡ Rational −1/2).
v3.2: answer_parser recognizes ``\\text{ANSWER: ...}`` markers (math vs format still split).
v3.3: EmptySet-safe canonicalization (SymPy empty intervals); ``\\emptyset`` ↔ no solution.
Historical reports under older graderVersion strings must not be silently rescored.
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

from answer_parser import GRADER_VERSION, parse_model_output

TRANSFORMS = standard_transformations + (implicit_multiplication_application,)

NO_SOLUTION_TOKENS = {
    "no solution",
    "none",
    "∅",
    "emptyset",
    "empty set",
    "varnothing",
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


def _normalize_latex_math(text: str) -> str:
    """Safely normalize a narrow subset of LaTeX math into parseable text.

    Does not evaluate arbitrary TeX or execute code — only textual rewrites.
    """
    t = (text or "").strip()
    # \frac{a}{b} -> (a)/(b)  (non-nested simple forms; iterate)
    for _ in range(8):
        nxt = re.sub(r"\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}", r"(\1)/(\2)", t)
        if nxt == t:
            break
        t = nxt
    t = t.replace("\\cdot", "*").replace("\\times", "*")
    t = t.replace("\\left", "").replace("\\right", "")
    t = t.replace("\\,", "").replace("\\;", "").replace("\\!", "")
    t = t.replace("\\infty", "oo").replace("∞", "oo")
    t = t.replace("\\emptyset", "emptyset").replace("\\varnothing", "varnothing")
    t = t.replace("\\cup", "U").replace("∪", "U")
    t = t.replace("\\pi", "pi").replace("\\%", "/100")
    t = re.sub(r"\\sqrt\s*\{([^{}]+)\}", r"sqrt(\1)", t)
    t = t.replace("$", "")
    t = t.replace("^", "**")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _normalize_text(text: str) -> str:
    return _normalize_latex_math(text)


def _parse_expr(text: str, local_dict: dict[str, Any] | None = None) -> sp.Expr:
    cleaned = _normalize_text(text)
    return parse_expr(
        cleaned,
        local_dict=local_dict or {"x": sp.Symbol("x"), "pi": sp.pi, "sqrt": sp.sqrt},
        transformations=TRANSFORMS,
        evaluate=True,
    )


def _split_root_list(text: str) -> list[str]:
    cleaned = _normalize_text(text)
    if cleaned.startswith("{") and cleaned.endswith("}"):
        cleaned = cleaned[1:-1]
    # Parenthesized multi-root lists: "(4, 8)" → "4, 8".
    # Do not unwrap interval-like forms (-oo, a) / (a, oo).
    if cleaned.startswith("(") and cleaned.endswith(")") and "," in cleaned:
        inner = cleaned[1:-1].strip()
        left_s, _, right_s = inner.partition(",")
        left_n = _normalize_text(left_s).lower()
        right_n = _normalize_text(right_s).lower()
        if left_n not in {"-oo", "+-oo"} and right_n not in {"oo", "+oo"}:
            cleaned = inner
    if not cleaned:
        return []
    parts: list[str] = []
    depth = 0
    current: list[str] = []
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


def _parse_endpoint(raw: str) -> sp.Expr:
    """Parse an interval endpoint; prefer exact rationals for finite decimals."""
    s = _normalize_text(str(raw)).strip()
    if s in {"-oo", "-∞"}:
        return -sp.oo
    if s in {"oo", "∞", "+oo", "+∞"}:
        return sp.oo
    expr = _parse_expr(s)
    try:
        # -0.5 → -1/2 so Interval construction matches Rational expected ends.
        return sp.nsimplify(expr, rational=True)
    except Exception:
        return expr


def _is_empty_set(obj: Any) -> bool:
    """True for SymPy EmptySet (including empty Interval constructions)."""
    if obj is None:
        return False
    if obj is sp.EmptySet:
        return True
    try:
        if isinstance(obj, sp.Set) and obj == sp.EmptySet:
            return True
    except Exception:
        return False
    return False


def _try_parse_interval(text: str) -> sp.Interval | Any | None:
    """Parse bracketed interval text.

    May return ``sp.EmptySet`` when SymPy collapses an empty interval
    (e.g. ``(5, 5)`` or ``(8, 4)``). Callers must not assume Interval attributes.
    """
    inner = _normalize_text(text).strip()
    if len(inner) < 3 or inner[0] not in "([" or inner[-1] not in ")]":
        return None
    left_open = inner[0] == "("
    right_open = inner[-1] == ")"
    body = inner[1:-1]
    try:
        left_s, right_s = [p.strip() for p in body.split(",", 1)]
    except ValueError:
        return None
    try:
        left = _parse_endpoint(left_s)
        right = _parse_endpoint(right_s)
        return sp.Interval(left, right, left_open=left_open, right_open=right_open)
    except Exception:
        return None


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
                _parse_endpoint(str(expected["left"])),
                _parse_endpoint(str(expected["right"])),
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


def _endpoint_equal(a: sp.Expr, b: sp.Expr) -> bool:
    if a in (-sp.oo, sp.oo) or b in (-sp.oo, sp.oo):
        return a == b
    return _expr_equal(a, b)


def _intervals_equal(got: Any, want: Any) -> bool:
    """True when both are nonempty Intervals with matching openness/endpoints."""
    if _is_empty_set(got) or _is_empty_set(want):
        return _is_empty_set(got) and _is_empty_set(want)
    if not isinstance(got, sp.Interval) or not isinstance(want, sp.Interval):
        return False
    if bool(got.left_open) != bool(want.left_open):
        return False
    if bool(got.right_open) != bool(want.right_open):
        return False
    return _endpoint_equal(got.left, want.left) and _endpoint_equal(got.right, want.right)


def _interval_key(iv: sp.Interval) -> dict[str, Any]:
    lo = "(" if iv.left_open else "["
    ro = ")" if iv.right_open else "]"
    return {
        "ok": True,
        "key": f"interval:{lo}{iv.left},{iv.right}{ro}",
        "kind": "interval",
    }


def _set_canonical_key(obj: Any) -> dict[str, Any] | None:
    """Canonical key for SymPy Set / nested set expressions. None if unsupported."""
    if _is_empty_set(obj):
        return {"ok": True, "key": "no_solution", "kind": "no_solution"}
    if isinstance(obj, sp.Interval):
        return _interval_key(obj)
    if isinstance(obj, sp.FiniteSet):
        try:
            roots = sorted(str(sp.simplify(e)) for e in obj.args)
            return {"ok": True, "key": "roots:" + ",".join(roots), "kind": "roots"}
        except Exception:
            return {"ok": False, "key": None, "kind": "unparseable"}
    if isinstance(obj, set):
        try:
            roots = sorted(str(sp.simplify(e)) for e in obj)
            if not roots:
                return {"ok": True, "key": "no_solution", "kind": "no_solution"}
            return {"ok": True, "key": "roots:" + ",".join(roots), "kind": "roots"}
        except Exception:
            return {"ok": False, "key": None, "kind": "unparseable"}
    if isinstance(obj, sp.Union):
        try:
            parts: list[str] = []
            for arg in obj.args:
                sub = _set_canonical_key(arg)
                if sub is None or not sub.get("ok") or sub.get("key") is None:
                    return {"ok": False, "key": None, "kind": "unparseable"}
                if sub["kind"] == "no_solution":
                    continue
                parts.append(str(sub["key"]))
            if not parts:
                return {"ok": True, "key": "no_solution", "kind": "no_solution"}
            parts_sorted = sorted(parts)
            return {"ok": True, "key": "union:" + "|".join(parts_sorted), "kind": "union"}
        except Exception:
            return {"ok": False, "key": None, "kind": "unparseable"}
    return None


def canonical_answer_key(answer_text: str | None) -> dict[str, Any]:
    """Stable symbolic key for comparing two model answers without the expected value.

    Used by batch-invariance Gate v3 so ``1281/26`` and ``\\\\frac{1281}{26}`` agree,
    while two different wrong answers do not agree merely because both grade wrong.

    Never raises: malformed/unsupported inputs return controlled opaque/unparseable keys.
    """
    try:
        return _canonical_answer_key_impl(answer_text)
    except Exception:
        raw = None if answer_text is None else str(answer_text).strip()
        if not raw:
            return {"ok": True, "key": None, "kind": "missing"}
        return {"ok": False, "key": f"raw:{raw}", "kind": "opaque"}


def _canonical_answer_key_impl(answer_text: str | None) -> dict[str, Any]:
    if answer_text is None:
        return {"ok": True, "key": None, "kind": "missing"}
    text = str(answer_text).strip()
    if not text:
        return {"ok": True, "key": None, "kind": "missing"}
    low = _normalize_text(text).lower()
    if low in NO_SOLUTION_TOKENS or text in {"{}", "∅"}:
        return {"ok": True, "key": "no_solution", "kind": "no_solution"}
    if low in ALL_REALS_TOKENS or text in {"(-oo, oo)", "R"}:
        return {"ok": True, "key": "all_reals", "kind": "all_reals"}
    # Bracketed interval forms before multi-root / expression parse.
    # SymPy may return EmptySet for empty intervals — handle before Interval attrs.
    iv = _try_parse_interval(text)
    if iv is not None:
        if _is_empty_set(iv):
            return {"ok": True, "key": "no_solution", "kind": "no_solution"}
        if isinstance(iv, sp.Interval):
            return _interval_key(iv)
        set_key = _set_canonical_key(iv)
        if set_key is not None:
            return set_key
        return {"ok": False, "key": None, "kind": "unparseable"}
    # Prefer multi-root set when commas present at depth 0.
    parts = _split_root_list(text)
    if len(parts) > 1:
        try:
            roots = sorted(str(sp.simplify(_parse_expr(p))) for p in parts)
            return {"ok": True, "key": "roots:" + ",".join(roots), "kind": "roots"}
        except Exception:
            return {"ok": False, "key": None, "kind": "unparseable"}
    try:
        expr = sp.simplify(_parse_expr(text))
        set_key = _set_canonical_key(expr)
        if set_key is not None:
            return set_key
        return {"ok": True, "key": "expr:" + str(expr), "kind": "expression"}
    except Exception:
        return {"ok": False, "key": f"raw:{text}", "kind": "opaque"}


def answers_canonically_equal(a: str | None, b: str | None) -> dict[str, Any]:
    """Compare two answer strings via canonical_answer_key. Never raises."""
    try:
        ka = canonical_answer_key(a)
        kb = canonical_answer_key(b)
    except Exception as exc:
        return {
            "equal": False,
            "keyA": {"ok": False, "key": None, "kind": "opaque"},
            "keyB": {"ok": False, "key": None, "kind": "opaque"},
            "error": type(exc).__name__,
        }
    # Both missing → agree. One missing → disagree.
    if ka["kind"] == "missing" and kb["kind"] == "missing":
        return {"equal": True, "keyA": ka, "keyB": kb}
    if ka["kind"] == "missing" or kb["kind"] == "missing":
        return {"equal": False, "keyA": ka, "keyB": kb}
    # Opaque unequal raw strings must not collapse.
    if ka.get("key") is None or kb.get("key") is None:
        return {"equal": False, "keyA": ka, "keyB": kb}
    equal = ka["key"] == kb["key"]
    # If both opaque raw keys differ, try expr equality via _expr_equal when parseable.
    if not equal and ka["kind"] == "expression" and kb["kind"] == "expression":
        try:
            equal = _expr_equal(_parse_expr(str(a)), _parse_expr(str(b)))
        except Exception:
            equal = False
    if not equal and ka["kind"] == "interval" and kb["kind"] == "interval":
        try:
            ia = _try_parse_interval(str(a))
            ib = _try_parse_interval(str(b))
            if ia is not None and ib is not None:
                equal = _intervals_equal(ia, ib)
        except Exception:
            equal = False
    return {"equal": bool(equal), "keyA": ka, "keyB": kb}


def grade_answer(answer_text: str, expected: dict[str, Any]) -> dict[str, Any]:
    exp = parse_expected(expected)
    text = _normalize_text(answer_text)
    low = text.lower()

    if exp["kind"] == "no_solution":
        ok = low in NO_SOLUTION_TOKENS or text in {"{}", "∅"}
        if not ok:
            iv = _try_parse_interval(text)
            if _is_empty_set(iv):
                ok = True
            else:
                try:
                    parsed = _parse_expr(text)
                    ok = _is_empty_set(parsed)
                except Exception:
                    ok = False
        return {"correct": ok, "detail": "no_solution"}

    if exp["kind"] == "all_reals":
        ok = low in ALL_REALS_TOKENS or text in {"(-oo, oo)", "R"}
        return {"correct": ok, "detail": "all_reals"}

    if exp["kind"] == "roots":
        # Empty-set answers are never correct for a nonempty root list.
        if low in NO_SOLUTION_TOKENS or text in {"{}", "∅"}:
            return {"correct": False, "detail": "empty_vs_roots"}
        iv_empty = _try_parse_interval(text)
        if _is_empty_set(iv_empty):
            return {"correct": False, "detail": "empty_vs_roots"}
        got = _as_root_set(text)
        if got is None:
            return {"correct": False, "detail": "unparseable_roots"}
        want = {sp.simplify(r) for r in exp["roots"]}
        if expected.get("multiset"):
            want_m = sorted(str(sp.simplify(r)) for r in exp["roots"])
            got_parts = _split_root_list(text)
            try:
                got_m = sorted(str(sp.simplify(_parse_expr(p))) for p in got_parts)
            except Exception:
                return {"correct": False, "detail": "unparseable_roots"}
            return {"correct": want_m == got_m, "detail": "multiset_roots"}
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
        got = _try_parse_interval(text)
        if got is None:
            if text.startswith("(") or text.startswith("["):
                return {"correct": False, "detail": "unparseable_interval"}
            return {"correct": False, "detail": "interval_format"}
        if _is_empty_set(got):
            # EmptySet never equals a nonempty expected interval.
            return {"correct": False, "detail": "empty_vs_interval"}
        if not isinstance(got, sp.Interval):
            return {"correct": False, "detail": "unparseable_interval"}
        return {"correct": _intervals_equal(got, exp["interval"]), "detail": "interval"}

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
    try:
        parsed = parse_model_output(raw, enable_thinking=enable_thinking, truncated=truncated)
    except Exception as exc:
        return {
            "graderVersion": GRADER_VERSION,
            "parsed": None,
            "formatCompliant": False,
            "answerMarkerUsed": None,
            "thinkingProtocolViolation": False,
            "mathematicalCorrect": False,
            "correct": False,
            "outcome": "grader_error",
            "grade": None,
            "invalidReason": f"parse_error:{type(exc).__name__}",
            "graderError": {
                "stage": "parse_model_output",
                "exceptionType": type(exc).__name__,
                "exceptionMessage": str(exc)[:500],
                "rawOutputLogged": True,
                "rawOutputPreview": (raw or "")[:4000],
            },
        }
    base = {
        "graderVersion": GRADER_VERSION,
        "parsed": parsed,
        "formatCompliant": bool(parsed.get("formatCompliant")),
        "answerMarkerUsed": parsed.get("answerMarkerUsed"),
        "thinkingProtocolViolation": bool(parsed.get("thinkingProtocolViolation")),
        "mathematicalCorrect": False,
        "correct": False,
    }
    if not parsed["ok"]:
        outcome = parsed["outcomeClass"]
        label = "truncated" if outcome == "truncated" else "invalid"
        return {
            **base,
            "outcome": label,
            "grade": None,
            "invalidReason": parsed.get("reason"),
        }
    try:
        grade = grade_answer(str(parsed["mathText"] or parsed["answer"]), expected)
    except Exception as exc:
        return {
            **base,
            "outcome": "grader_error",
            "grade": None,
            "invalidReason": f"grade_error:{type(exc).__name__}",
            "graderError": {
                "stage": "grade_answer",
                "exceptionType": type(exc).__name__,
                "exceptionMessage": str(exc)[:500],
                "rawOutputLogged": True,
                "rawOutputPreview": (raw or "")[:4000],
                "mathText": parsed.get("mathText") or parsed.get("answer"),
            },
        }
    math_ok = bool(grade["correct"])
    return {
        **base,
        "outcome": "correct" if math_ok else "wrong",
        "correct": math_ok,
        "mathematicalCorrect": math_ok,
        "grade": grade,
        "invalidReason": None,
    }
