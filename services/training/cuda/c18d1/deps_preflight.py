#!/usr/bin/env python3
"""Preflight dependency checks for C1.8D.1 GPU / local eval scripts."""

from __future__ import annotations

import importlib
import sys


# Always required for any C1.8D.1 eval/grading path.
REQUIRED_CORE = (
    ("sympy", "SymPy is required for grading"),
)

# Required on GPU VM eval scripts (HF official backend).
REQUIRED_GPU = (
    ("torch", "PyTorch is required for generation"),
    ("transformers", "transformers is required for HF evaluation"),
)


def check_required(*, gpu: bool = True) -> None:
    missing: list[str] = []
    for module, hint in REQUIRED_CORE + (REQUIRED_GPU if gpu else ()):
        try:
            importlib.import_module(module)
        except ImportError:
            missing.append(f"{module}: {hint}")
    if missing:
        print("C1.8D.1 dependency preflight FAILED:", file=sys.stderr)
        for line in missing:
            print(f"  - {line}", file=sys.stderr)
        print(
            "Fix: activate the c18d1 venv and run "
            "`pip install -r services/training/cuda/requirements-c18d1.txt` "
            "(unset C18D1_SKIP_INSTALL until deps including sympy are present).",
            file=sys.stderr,
        )
        raise SystemExit(3)
    print("c18d1 deps preflight ok")


def main() -> None:
    check_required(gpu=True)


if __name__ == "__main__":
    main()
