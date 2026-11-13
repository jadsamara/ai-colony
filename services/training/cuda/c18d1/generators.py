#!/usr/bin/env python3
"""Deterministic SymPy-backed algebra item generators for C1.8D.1.

Difficulty is structural (transforms, nesting, traps), not arbitrary labels.
OOD families differ in algebraic structure, not merely random seed.
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

import sympy as sp

BENCHMARK_VERSION = "c18d1-algebra-v2"
GENERATOR_VERSION = "c18d1-gen-v2"
# Locked splits under c18d1-algebra-v1 were committed to git (answers + streamSeed)
# and are retired — never use for evaluation or training.
RETIRED_LOCKED_BENCHMARK_VERSION = "c18d1-algebra-v1"

# Department / ownership constants (match seed UUIDs).
EVALUATION_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000017"
MATH_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000019"
WEIGHT_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000015"

ID_FAMILIES = [
    "linear_equations",
    "linear_systems",
    "quadratic_equations",
    "polynomial_factorization",
    "rational_equations",
    "radical_equations",
    "absolute_value_equations",
    "inequalities",
    "exponential_log_equations",
    "symbolic_simplification",
]

# Structural OOD: not used for training/dev prompt tuning.
OOD_FAMILIES = [
    # Trig identities / equations are absent from ID families.
    "trigonometric_equations",
    # Integer Diophantine constraints differ from real closed-form algebra.
    "linear_diophantine",
    # Piecewise definitions introduce branch structure absent from ID templates.
    "piecewise_equations",
]

DIFFICULTY_DEFS = {
    "easy": {
        "maxTransforms": 1,
        "maxNesting": 1,
        "coefficientBits": 3,
        "domainTrap": False,
        "extraneousTrap": False,
    },
    "moderate": {
        "maxTransforms": 2,
        "maxNesting": 2,
        "coefficientBits": 5,
        "domainTrap": True,
        "extraneousTrap": False,
    },
    "hard": {
        "maxTransforms": 4,
        "maxNesting": 3,
        "coefficientBits": 6,
        "domainTrap": True,
        "extraneousTrap": True,
    },
}

# Public (in-repo) stream seeds only. Locked seeds are external — see locked_seeds.py.
PUBLIC_SEEDS = {
    "dev": 181801,
    "regression": 181804,
    "overlap_audit": 181805,
}


@dataclass
class Item:
    id: str
    split: str
    family: str
    distribution: str  # id | ood | regression
    difficulty: str
    prompt: str
    expected: dict[str, Any]
    structuralTags: list[str]
    provenance: dict[str, Any]
    contentDigest: str


def _digest(payload: dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def _item_id(split: str, family: str, index: int, digest: str) -> str:
    return f"{BENCHMARK_VERSION}:{split}:{family}:{index:04d}:{digest[:12]}"


def _rng(stream_seed: int, family: str, index: int) -> random.Random:
    seed = int(stream_seed) ^ (zlib_crc(family) << 1) ^ (index * 1_000_003)
    return random.Random(seed)


def zlib_crc(text: str) -> int:
    import zlib

    return zlib.crc32(text.encode()) & 0xFFFFFFFF


def _coef(rng: random.Random, difficulty: str, nonzero: bool = True) -> int:
    bits = DIFFICULTY_DEFS[difficulty]["coefficientBits"]
    span = 2 ** bits
    while True:
        value = rng.randint(-span, span)
        if not nonzero or value != 0:
            return value


def _pick_difficulty(rng: random.Random) -> str:
    return rng.choice(["easy", "moderate", "hard"])


def gen_linear_equations(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x")
    a = _coef(rng, difficulty)
    b = _coef(rng, difficulty, nonzero=False)
    c = _coef(rng, difficulty)
    d = _coef(rng, difficulty, nonzero=False)
    # a(x+b) = c(x+d) + e style
    e = _coef(rng, difficulty, nonzero=False)
    left = sp.expand(a * (x + b))
    right = sp.expand(c * (x + d) + e)
    eq = sp.Eq(left, right)
    sol = sp.solve(eq, x)
    tags = ["linear", f"transforms<={DIFFICULTY_DEFS[difficulty]['maxTransforms']}"]
    prompt = (
        f"Solve for x over the reals. Show work if useful, then end with exactly one line "
        f"`ANSWER: <value>` (or `ANSWER: no solution`).\n\nEquation: {left} = {right}"
    )
    if not sol:
        return prompt, {"kind": "no_solution"}, tags + ["no_solution"]
    return prompt, {"kind": "roots", "values": [str(sol[0])], "variable": "x"}, tags


def gen_linear_systems(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x, y = sp.symbols("x y")
    # Construct a unique solution then emit equations.
    sx = _coef(rng, difficulty, nonzero=False)
    sy = _coef(rng, difficulty, nonzero=False)
    a1, b1 = _coef(rng, difficulty), _coef(rng, difficulty)
    a2, b2 = _coef(rng, difficulty), _coef(rng, difficulty)
    if a1 * b2 == a2 * b1:
        b2 += 1
    c1 = a1 * sx + b1 * sy
    c2 = a2 * sx + b2 * sy
    tags = ["linear_system", "two_variable"]
    prompt = (
        "Solve the linear system over the reals. Final line must be "
        "`ANSWER: (<x>, <y>)` or `ANSWER: no solution`.\n\n"
        f"{a1}*x + {b1}*y = {c1}\n{a2}*x + {b2}*y = {c2}"
    )
    return (
        prompt,
        {"kind": "expression", "value": f"({sx}, {sy})"},
        tags,
    )


def gen_quadratic_equations(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x")
    # Construct from known roots for exactness.
    r1 = _coef(rng, difficulty, nonzero=False)
    r2 = _coef(rng, difficulty, nonzero=False)
    a = _coef(rng, difficulty)
    poly = sp.expand(a * (x - r1) * (x - r2))
    tags = ["quadratic", "constructed_roots"]
    if DIFFICULTY_DEFS[difficulty]["extraneousTrap"] and rng.random() < 0.3:
        tags.append("repeated_root_possible")
    prompt = (
        f"Solve for x over the reals. End with `ANSWER: <roots>` as a comma-separated list "
        f"(order irrelevant), or `ANSWER: no solution`.\n\nEquation: {poly} = 0"
    )
    roots = sorted({r1, r2})
    return prompt, {"kind": "roots", "values": [str(r) for r in roots], "variable": "x"}, tags


def gen_polynomial_factorization(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x")
    r1, r2, r3 = (_coef(rng, difficulty, nonzero=False) for _ in range(3))
    if difficulty == "easy":
        poly = sp.expand((x - r1) * (x - r2))
        roots = sorted({r1, r2})
    else:
        poly = sp.expand((x - r1) * (x - r2) * (x - r3))
        roots = sorted({r1, r2, r3})
    prompt = (
        f"Find all real roots of the polynomial. End with `ANSWER: <roots>` comma-separated.\n\n"
        f"p(x) = {poly}"
    )
    return prompt, {"kind": "roots", "values": [str(r) for r in roots], "variable": "x"}, ["polynomial", "factorization"]


def gen_rational_equations(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x")
    # (x-a)/(x-b) = c  with domain x!=b
    a = _coef(rng, difficulty, nonzero=False)
    b = _coef(rng, difficulty)
    c = _coef(rng, difficulty)
    if a == b:
        a += 1
    eq = sp.Eq((x - a) / (x - b), c)
    sol = [s for s in sp.solve(eq, x) if s != b]
    tags = ["rational", "domain_restriction"]
    prompt = (
        f"Solve for x over the reals, excluding values that make a denominator zero. "
        f"End with `ANSWER: <value(s)>` or `ANSWER: no solution`.\n\n"
        f"(x - {a})/(x - {b}) = {c}"
    )
    if not sol:
        return prompt, {"kind": "no_solution"}, tags + ["no_solution"]
    return prompt, {"kind": "roots", "values": [str(s) for s in sol], "variable": "x"}, tags


def gen_radical_equations(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x")
    # sqrt(x - a) = b  => x = b^2 + a, require b>=0 and x>=a
    a = abs(_coef(rng, difficulty, nonzero=False))
    b = abs(_coef(rng, difficulty, nonzero=False))
    tags = ["radical", "extraneous_check"]
    if DIFFICULTY_DEFS[difficulty]["extraneousTrap"]:
        # Present squared form that can introduce extraneous roots if unchecked.
        prompt = (
            f"Solve for x over the reals. Check for extraneous roots. "
            f"End with `ANSWER: <value>` or `ANSWER: no solution`.\n\n"
            f"sqrt(x - {a}) = {b} - x"
        )
        eq = sp.Eq(sp.sqrt(x - a), b - x)
        candidates = sp.solve(eq, x)
        sols = []
        for s in candidates:
            try:
                if s.is_real is False:
                    continue
                if s < a:
                    continue
                if (b - s) < 0:
                    continue
                if sp.simplify(sp.sqrt(s - a) - (b - s)) == 0:
                    sols.append(s)
            except Exception:
                continue
        if not sols:
            return prompt, {"kind": "no_solution"}, tags + ["extraneous_trap", "no_solution"]
        return prompt, {"kind": "roots", "values": [str(s) for s in sols], "variable": "x"}, tags + ["extraneous_trap"]
    prompt = (
        f"Solve for x over the reals. End with `ANSWER: <value>`.\n\n"
        f"sqrt(x - {a}) = {b}"
    )
    return prompt, {"kind": "roots", "values": [str(b * b + a)], "variable": "x"}, tags


def gen_absolute_value_equations(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x", real=True)
    a = _coef(rng, difficulty)
    b = abs(_coef(rng, difficulty))
    # Construct solutions directly: x = a ± b
    sols = sorted({a + b, a - b})
    prompt = (
        f"Solve for x over the reals. End with `ANSWER: <roots>` comma-separated.\n\n"
        f"|x - {a}| = {b}"
    )
    return prompt, {"kind": "roots", "values": [str(s) for s in sols], "variable": "x"}, ["absolute_value"]


def gen_inequalities(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x", real=True)
    a = _coef(rng, difficulty)
    b = _coef(rng, difficulty, nonzero=False)
    strict = difficulty != "hard"
    expr = a * x + b
    # a*x + b ? 0  =>  x ? -b/a  (direction depends on sign of a)
    boundary = sp.Rational(-b, a)
    if a > 0:
        left, right = str(boundary), "oo"
        left_open, right_open = strict, True
        if not strict:
            left_open = False
    else:
        left, right = "-oo", str(boundary)
        left_open, right_open = True, strict
        if not strict:
            right_open = False
    rel = ">" if strict else ">="
    prompt = (
        f"Solve the inequality over the reals. End with `ANSWER: <interval>` using "
        f"standard interval notation with -oo/oo.\n\n{expr} {rel} 0"
    )
    return (
        prompt,
        {
            "kind": "interval",
            "left": left,
            "right": right,
            "leftOpen": left_open,
            "rightOpen": right_open,
        },
        ["inequality", "linear"],
    )


def gen_exponential_log_equations(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x")
    # 2^(x-a) = 2^b  => x = a+b ; or log form
    a = _coef(rng, difficulty, nonzero=False)
    b = _coef(rng, difficulty, nonzero=False)
    if rng.random() < 0.5:
        prompt = (
            f"Solve for x over the reals. End with `ANSWER: <value>`.\n\n"
            f"2**(x - {a}) = 2**({b})"
        )
        return prompt, {"kind": "roots", "values": [str(a + b)], "variable": "x"}, ["exponential"]
    # log2(x) = b => x = 2^b (require x>0)
    prompt = (
        f"Solve for x over the reals (domain x > 0). End with `ANSWER: <value>`.\n\n"
        f"log(x)/log(2) = {b}"
    )
    return prompt, {"kind": "roots", "values": [str(2 ** b)], "variable": "x"}, ["logarithm", "domain_restriction"]


def gen_symbolic_simplification(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x")
    a = _coef(rng, difficulty)
    b = _coef(rng, difficulty, nonzero=False)
    c = _coef(rng, difficulty)
    expr = sp.expand((a * x + b) * (c * x - b) - a * c * x ** 2)
    simplified = sp.simplify(expr)
    prompt = (
        f"Simplify the algebraic expression. End with `ANSWER: <simplified expression>` in x.\n\n"
        f"{expr}"
    )
    return prompt, {"kind": "expression", "value": str(simplified)}, ["simplification", "identity"]


def gen_trigonometric_equations(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    catalog = [
        ("sin(x) = 1/2", [sp.pi / 6, 5 * sp.pi / 6]),
        ("cos(x) = 1/2", [sp.pi / 3, 5 * sp.pi / 3]),
        ("sin(x) = 0", [sp.Integer(0), sp.pi]),
        ("cos(x) = 0", [sp.pi / 2, 3 * sp.pi / 2]),
        ("sin(x) = 1", [sp.pi / 2]),
        ("cos(x) = 1", [sp.Integer(0)]),
        ("sin(x) = -1/2", [7 * sp.pi / 6, 11 * sp.pi / 6]),
        ("cos(x) = -1/2", [2 * sp.pi / 3, 4 * sp.pi / 3]),
        ("tan(x) = 1", [sp.pi / 4, 5 * sp.pi / 4]),
        ("tan(x) = 0", [sp.Integer(0), sp.pi]),
    ]
    # Shift catalog choice by rng so streams diverge even for the same index.
    choice = catalog[(index + rng.randint(0, len(catalog) - 1)) % len(catalog)]
    # Unique harmless parameter: solve k*x form with k in {1,2} derived from index+rng.
    k = 1 + ((index + rng.randint(0, 1)) % 2)
    eq = choice[0]
    roots = choice[1]
    if k != 1:
        # sin(2x)=1/2 etc. — keep expected roots as principal solutions divided by k when safe.
        left, right = eq.split("=")
        fn = left.strip()
        eq = f"{fn.replace('(x)', f'({k}*x)')} = {right.strip()}"
        roots = [sp.simplify(r / k) for r in roots]
    prompt = (
        "Solve for x in [0, 2*pi). End with `ANSWER: <roots>` comma-separated "
        f"in terms of pi if needed.\n\n{eq}"
    )
    return (
        prompt,
        {"kind": "roots", "values": [str(r) for r in roots], "variable": "x"},
        ["ood", "trigonometric"],
    )


def gen_linear_diophantine(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    # ax + by = c integer solutions — ask for one particular non-negative solution or none.
    a = rng.choice([2, 3, 4, 5, 6])
    b = rng.choice([3, 5, 7, 9])
    x0 = rng.randint(0, 8)
    y0 = rng.randint(0, 8)
    c = a * x0 + b * y0
    prompt = (
        "Find one particular non-negative integer solution (x, y) to the Diophantine equation. "
        "End with `ANSWER: (x, y)` or `ANSWER: no solution`.\n\n"
        f"{a}*x + {b}*y = {c}"
    )
    return prompt, {"kind": "expression", "value": f"({x0}, {y0})"}, ["ood", "diophantine", "integer"]


def gen_piecewise_equations(rng: random.Random, difficulty: str, index: int) -> tuple[str, dict[str, Any], list[str]]:
    x = sp.Symbol("x")
    a = _coef(rng, difficulty)
    # x+1 = 3 for x<0 branch unused; for x>=0: 2x-a = 0
    sol = sp.Rational(a, 2)
    prompt = (
        "Solve for x over the reals using the piecewise definition. "
        "End with `ANSWER: <value>` or `ANSWER: no solution`.\n\n"
        f"f(x) = x + 1  if x < 0;  2*x - {a}  if x >= 0\n"
        "Solve f(x) = 0."
    )
    # Valid only if sol >= 0
    if sol < 0:
        return prompt, {"kind": "no_solution"}, ["ood", "piecewise", "no_solution"]
    return prompt, {"kind": "roots", "values": [str(sol)], "variable": "x"}, ["ood", "piecewise"]


GENERATORS: dict[str, Callable[[random.Random, str, int], tuple[str, dict[str, Any], list[str]]]] = {
    "linear_equations": gen_linear_equations,
    "linear_systems": gen_linear_systems,
    "quadratic_equations": gen_quadratic_equations,
    "polynomial_factorization": gen_polynomial_factorization,
    "rational_equations": gen_rational_equations,
    "radical_equations": gen_radical_equations,
    "absolute_value_equations": gen_absolute_value_equations,
    "inequalities": gen_inequalities,
    "exponential_log_equations": gen_exponential_log_equations,
    "symbolic_simplification": gen_symbolic_simplification,
    "trigonometric_equations": gen_trigonometric_equations,
    "linear_diophantine": gen_linear_diophantine,
    "piecewise_equations": gen_piecewise_equations,
}


def make_item(
    *,
    stream: str,
    stream_seed: int,
    family: str,
    index: int,
    distribution: str,
    split: str,
    seed_hash: str | None = None,
    record_public_seed: bool = False,
) -> Item:
    rng = _rng(stream_seed, family, index)
    difficulty = _pick_difficulty(rng)
    prompt, expected, tags = GENERATORS[family](rng, difficulty, index)
    # Opaque per-item ref (no split/family path) keeps prompts unique without leaking identity.
    opaque_ref = hashlib.sha256(
        f"{stream_seed}:{family}:{index}:{GENERATOR_VERSION}".encode(),
    ).hexdigest()[:10]
    prompt = f"{prompt}\n\nRef: {opaque_ref}"
    # Instance IDs stay in metadata/id only — never embed split names in the prompt text.
    body: dict[str, Any] = {
        "family": family,
        "split": split,
        "index": index,
        "difficulty": difficulty,
        "prompt": prompt,
        "expected": expected,
        "generatorVersion": GENERATOR_VERSION,
        "stream": stream,
    }
    if record_public_seed:
        body["streamSeed"] = stream_seed
    if seed_hash is not None:
        body["seedHash"] = seed_hash
    digest = _digest(body)
    provenance: dict[str, Any] = {
        "benchmarkVersion": BENCHMARK_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "stream": stream,
        "family": family,
        "index": index,
        "ownerDepartmentId": EVALUATION_DEPARTMENT_ID,
        "forbiddenConsumers": [MATH_DEPARTMENT_ID, WEIGHT_DEPARTMENT_ID],
    }
    if record_public_seed:
        # Dev/regression only — locked items must never carry raw stream seeds.
        provenance["streamSeed"] = stream_seed
    if seed_hash is not None:
        provenance["seedHash"] = seed_hash
    return Item(
        id=_item_id(split, family, index, digest),
        split=split,
        family=family,
        distribution=distribution,
        difficulty=difficulty,
        prompt=prompt,
        expected=expected,
        structuralTags=tags,
        provenance=provenance,
        contentDigest=digest,
    )


def generate_split(
    *,
    stream: str,
    stream_seed: int,
    families: list[str],
    per_family: int,
    distribution: str,
    split: str,
    seed_hash: str | None = None,
    record_public_seed: bool = False,
) -> list[Item]:
    items: list[Item] = []
    for family in families:
        for index in range(per_family):
            items.append(
                make_item(
                    stream=stream,
                    stream_seed=stream_seed,
                    family=family,
                    index=index,
                    distribution=distribution,
                    split=split,
                    seed_hash=seed_hash,
                    record_public_seed=record_public_seed,
                ),
            )
    return items


def prompt_leaks_split_identity(prompt: str) -> bool:
    """True if a prompt embeds split names or retired Instance tags."""
    text = prompt or ""
    if "Instance:" in text:
        return True
    lowered = text.lower()
    for token in (
        "locked_id",
        "locked_ood",
        "locked-id",
        "locked-ood",
        "/development/",
        "/regression/",
        "c18d1-algebra-v1/",
        "c18d1-algebra-v2/",
        "split=",
        "stream=",
    ):
        if token in lowered:
            return True
    return False


def write_jsonl(path: Path, items: list[Item]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(asdict(item), sort_keys=True) + "\n")


def manifest_for(items: list[Item], *, name: str) -> dict[str, Any]:
    digests = sorted(item.contentDigest for item in items)
    return {
        "name": name,
        "benchmarkVersion": BENCHMARK_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "itemCount": len(items),
        "families": sorted({item.family for item in items}),
        "difficulties": {
            key: sum(1 for item in items if item.difficulty == key)
            for key in ("easy", "moderate", "hard")
        },
        "contentHash": _digest({"digests": digests}),
        "ownerDepartmentId": EVALUATION_DEPARTMENT_ID,
        "access": {
            "itemLevel": "evaluation_only",
            "aggregateSummaries": "learning_agents_allowed",
        },
    }
