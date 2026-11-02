"""Corrected loss mask for the installed MLX-LM 0.32.2 trainer.

This module is not imported by the training worker. Phase 1A does not run it
inside an optimizer step.
"""

from __future__ import annotations


def mask_rows(offset: int, token_count: int, target_width: int, upper: str) -> list[bool]:
    if upper not in {"installed", "corrected"}:
        raise ValueError("unknown mask")
    rows = []
    for step in range(1, target_width + 1):
        if upper == "installed":
            rows.append(step >= offset and step <= token_count)
        else:
            rows.append(step >= offset and step < token_count)
    return rows
