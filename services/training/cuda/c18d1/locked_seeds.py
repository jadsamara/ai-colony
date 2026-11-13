#!/usr/bin/env python3
"""External locked-stream seeds for C1.8D.1 algebra v2.

Locked seeds must never live in the repo. Provide them via:
  - C18D1_LOCKED_SEED_FILE: absolute path outside the repo to a JSON file
    {"locked_id": <int>, "locked_ood": <int>}
  - or C18D1_LOCKED_SEED_ID and C18D1_LOCKED_SEED_OOD environment variables

Only a SHA-256 hash of the canonical seed material is recorded in manifests.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

REPO_C18D1 = Path(__file__).resolve().parent
# c18d1 → cuda → training → services → <repo root>
REPO_ROOT = REPO_C18D1.parents[3]


class LockedSeedError(RuntimeError):
    pass


def _assert_outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise LockedSeedError(
        f"Locked seed path must be outside the repository ({REPO_ROOT}); got {resolved}",
    )


def _canonical_seed_blob(locked_id: int, locked_ood: int) -> bytes:
    payload = {"locked_id": int(locked_id), "locked_ood": int(locked_ood)}
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def seed_material_hash(locked_id: int, locked_ood: int) -> str:
    return hashlib.sha256(_canonical_seed_blob(locked_id, locked_ood)).hexdigest()


def load_locked_stream_seeds() -> dict[str, Any]:
    """Load locked_id / locked_ood seeds from env or external file. Never from the repo."""
    seed_file = os.environ.get("C18D1_LOCKED_SEED_FILE", "").strip()
    env_id = os.environ.get("C18D1_LOCKED_SEED_ID", "").strip()
    env_ood = os.environ.get("C18D1_LOCKED_SEED_OOD", "").strip()

    if seed_file:
        path = _assert_outside_repo(Path(seed_file))
        if not path.is_file():
            raise LockedSeedError(f"C18D1_LOCKED_SEED_FILE not found: {path}")
        # Refuse world-readable seeds when possible (best-effort).
        mode = path.stat().st_mode & 0o777
        if mode & 0o077:
            raise LockedSeedError(
                f"Locked seed file must not be group/world accessible (mode={oct(mode)}): {path}",
            )
        raw = json.loads(path.read_text(encoding="utf-8"))
        try:
            locked_id = int(raw["locked_id"])
            locked_ood = int(raw["locked_ood"])
        except (KeyError, TypeError, ValueError) as exc:
            raise LockedSeedError(
                "Seed file must contain integer keys locked_id and locked_ood",
            ) from exc
        source = f"file:{path}"
    elif env_id and env_ood:
        try:
            locked_id = int(env_id)
            locked_ood = int(env_ood)
        except ValueError as exc:
            raise LockedSeedError("C18D1_LOCKED_SEED_ID/OOD must be integers") from exc
        source = "env:C18D1_LOCKED_SEED_ID+C18D1_LOCKED_SEED_OOD"
    else:
        raise LockedSeedError(
            "Locked generator requires external seeds: set C18D1_LOCKED_SEED_FILE "
            "(path outside the repo) or both C18D1_LOCKED_SEED_ID and C18D1_LOCKED_SEED_OOD. "
            "Refusing to generate locked splits without them.",
        )

    return {
        "locked_id": locked_id,
        "locked_ood": locked_ood,
        "seedHash": seed_material_hash(locked_id, locked_ood),
        "sourceKind": "file" if seed_file else "env",
        # Do not include raw seeds in returned dict fields that get written to repo manifests.
        # Callers that need raw seeds for RNG must read locked_id/locked_ood locally only.
        "_rawSource": source,
    }


def require_locked_output_dir(path: Path | str) -> Path:
    """Locked JSONL must be written outside the repo (and ideally outside agent mounts)."""
    resolved = Path(path).expanduser().resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise LockedSeedError(
        f"Locked data directory must be outside the repository ({REPO_ROOT}); got {resolved}",
    )
