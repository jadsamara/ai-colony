#!/usr/bin/env python3
"""Exact symbolic expected-answer representations (dataset expected-exact-v1).

Fixes float approximations such as ``str(2 ** -40)`` → ``'9.09e-13'`` by using
SymPy integer powers. Used by generators (gen-v3+) and offline regrade overlays
for historical gen-v2 items (prompt-based recovery; floats alone are lossy).
"""

from __future__ import annotations

import re
from typing import Any

import sympy as sp

EXPECTED_CORRECTION_VERSION = "c18d1-expected-exact-v1"
GENERATOR_VERSION_PREVIOUS = "c18d1-gen-v2"

_LOG2_EQ = re.compile(r"log\(x\)\s*/\s*log\(2\)\s*=\s*(-?\d+)", re.I)
_FLOATISH = re.compile(r"^[+-]?(?:\d+\.\d+|\d+\.?\d*[eE][+-]?\d+)$")


def exact_pow2(exponent: int | sp.Expr) -> str:
    """Exact decimal/rational string for ``2**exponent`` (never a binary float)."""
    exp = int(exponent)
    return str(sp.Integer(2) ** exp)


def looks_floatish(text: str) -> bool:
    s = str(text).strip()
    return bool(_FLOATISH.match(s))


def correct_expected(
    expected: dict[str, Any],
    *,
    prompt: str | None = None,
) -> dict[str, Any]:
    """Return a copy of ``expected`` with exact symbolic forms where applicable.

    Prefer prompt recovery for ``log(x)/log(2) = b`` items. Also rewrites any
    root/expression values that are floatish dyadic powers of two when an
    exact match ``2**k`` agrees within float tolerance for small |k|.
    """
    out = dict(expected)
    kind = out.get("kind")

    # Prompt-authoritative correction for logarithm items.
    if prompt:
        m = _LOG2_EQ.search(prompt)
        if m and kind == "roots":
            b = int(m.group(1))
            out = {
                **out,
                "kind": "roots",
                "values": [exact_pow2(b)],
                "variable": out.get("variable", "x"),
            }
            out["_expectedCorrection"] = {
                "version": EXPECTED_CORRECTION_VERSION,
                "reason": "log2_equation_exact_pow2",
                "exponent": b,
            }
            return out

    if kind == "roots":
        vals = []
        changed = False
        for v in out.get("values") or []:
            nv, did = _exactify_scalar(str(v))
            vals.append(nv)
            changed = changed or did
        if changed:
            out = {**out, "values": vals}
            out["_expectedCorrection"] = {
                "version": EXPECTED_CORRECTION_VERSION,
                "reason": "floatish_root_exactified",
            }
    elif kind == "expression" and out.get("value") is not None:
        nv, did = _exactify_scalar(str(out["value"]))
        if did:
            out = {**out, "value": nv}
            out["_expectedCorrection"] = {
                "version": EXPECTED_CORRECTION_VERSION,
                "reason": "floatish_expression_exactified",
            }
    return out


def _exactify_scalar(text: str) -> tuple[str, bool]:
    if not looks_floatish(text):
        return text, False
    try:
        f = float(text)
    except ValueError:
        return text, False
    # Match exact 2**k for modest exponents where float is faithful enough.
    for k in range(-60, 64):
        exact = sp.Integer(2) ** k
        try:
            if float(exact) == f:
                return str(exact), True
        except Exception:
            continue
    # Try Rational recovery for terminating dyadics that survived as decimals.
    try:
        rat = sp.nsimplify(sp.Float(text), rational=True)
        if isinstance(rat, sp.Rational) and rat.q != 0:
            # Prefer power-of-two form when denominator/numerator is 2**n
            for part in (rat.p, rat.q):
                if part != 0 and (abs(part) & (abs(part) - 1)) == 0:
                    return str(rat), True
            if rat.q > 1 and looks_floatish(text):
                return str(rat), True
    except Exception:
        pass
    return text, False


def strip_correction_metadata(expected: dict[str, Any]) -> dict[str, Any]:
    """Remove internal correction markers before writing durable datasets."""
    return {k: v for k, v in expected.items() if not str(k).startswith("_")}
