#!/usr/bin/env python3
"""Locked-test access control for C1.8D.1.

Item-level locked answers/predictions are Evaluation-only.
Math and Weight Optimization may receive approved aggregate summaries only.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

EVALUATION_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000017"
MATH_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000019"
WEIGHT_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000015"
MEMORY_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000016"

LOCKED_ROLE = "evaluation"
FORBIDDEN_ROLES = {"math", "weight_optimization", "memory", "monitoring", "ceo"}

ROOT = Path(__file__).resolve().parent
LOCKED_DIR = ROOT / "datasets" / "locked"
DEV_DIR = ROOT / "datasets" / "dev"
REGRESSION_DIR = ROOT / "datasets" / "regression"


class LockedTestAccessError(PermissionError):
    pass


def normalize_role(role: str | None, department_id: str | None = None) -> str:
    if role:
        return role.strip().lower().replace("-", "_").replace(" ", "_")
    mapping = {
        EVALUATION_DEPARTMENT_ID: "evaluation",
        MATH_DEPARTMENT_ID: "math",
        WEIGHT_DEPARTMENT_ID: "weight_optimization",
        MEMORY_DEPARTMENT_ID: "memory",
    }
    if department_id and department_id in mapping:
        return mapping[department_id]
    return "unknown"


def can_read_locked_items(*, role: str | None = None, department_id: str | None = None) -> bool:
    normalized = normalize_role(role, department_id)
    return normalized == LOCKED_ROLE


def assert_can_read_locked_items(*, role: str | None = None, department_id: str | None = None) -> None:
    if not can_read_locked_items(role=role, department_id=department_id):
        raise LockedTestAccessError(
            "Locked-test item-level artifacts are restricted to the Evaluation department. "
            "Math/Weight/Memory may receive approved aggregate summaries only.",
        )


def open_locked_dataset(
    name: str,
    *,
    role: str | None = None,
    department_id: str | None = None,
) -> Path:
    assert_can_read_locked_items(role=role, department_id=department_id)
    path = LOCKED_DIR / name
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def open_dev_dataset(name: str) -> Path:
    path = DEV_DIR / name
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def aggregate_summary_allowed(*, role: str | None = None, department_id: str | None = None) -> bool:
    """Learning agents may read approved aggregates; still no item-level locked data."""
    normalized = normalize_role(role, department_id)
    return normalized in {
        "evaluation",
        "math",
        "weight_optimization",
        "memory",
        "monitoring",
        "ceo",
        "research",
    }


def redact_item_level(summary: dict[str, Any]) -> dict[str, Any]:
    """Strip fields that must never leave Evaluation storage."""
    blocked = {
        "prompt",
        "expected",
        "rawPrediction",
        "predictions",
        "answer",
        "generatorSeed",
        "streamSeed",
        "contentDigest",
    }
    return {key: value for key, value in summary.items() if key not in blocked}


# Residual limitations (documented for operators).
RESIDUAL_LIMITATIONS = [
    "Filesystem ACLs on the GPU VM are operator-enforced; this module is the application gate.",
    "Committing locked JSONL to git means anyone with repo access can read files offline; "
    "treat the Evaluation host as the system of record and restrict clone access for training agents.",
    "Prompt-hiding alone is insufficient; this gate must wrap every loader and API.",
]
