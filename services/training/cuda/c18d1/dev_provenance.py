#!/usr/bin/env python3
"""Shared secure development-dataset provenance validation for C1.8D.1.

Authorized sources live under ``datasets/dev``. Generated temporary selections
(e.g. under ``tmp/…/selection/``) are accepted only when a selection manifest
proves they were derived from an authorized development source (item IDs,
content hashes, split/provenance checks). Locked ID/OOD data is always refused.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from access_control import DEV_DIR, LOCKED_DIR
from generators import ID_FAMILIES
from stratified_selection import (
    DIFFICULTIES,
    SELECTION_VERSION,
    dataset_content_hash,
    verify_item_provenance,
)

AUTHORIZED_DEV_SOURCES = (
    DEV_DIR / "id_dev.jsonl",
)


class DevelopmentProvenanceError(PermissionError):
    """Raised when a dataset is not an authorized development source or selection."""


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _reject_locked_or_escape(path: Path) -> Path:
    """Resolve path; reject locked roots, missing files, and escapes via symlink."""
    if not path.exists():
        raise DevelopmentProvenanceError(f"Dataset path does not exist: {path}")

    # Reject before resolve if any symlink component points into locked.
    current = path if path.is_absolute() else Path.cwd() / path
    for parent in [current, *current.parents]:
        if parent.exists() and parent.is_symlink():
            target = parent.resolve()
            if _is_under(target, LOCKED_DIR) or "locked" in {p.lower() for p in target.parts}:
                raise DevelopmentProvenanceError(
                    f"Symlink into locked data refused: {parent} -> {target}",
                )

    resolved = path.resolve()
    parts = {p.lower() for p in resolved.parts}
    if "locked" in parts or _is_under(resolved, LOCKED_DIR):
        raise DevelopmentProvenanceError(f"Locked dataset paths are forbidden: {resolved}")

    raw = str(path)
    if "\x00" in raw:
        raise DevelopmentProvenanceError("Null byte in dataset path")
    if "locked" in {p.lower() for p in Path(raw).parts}:
        raise DevelopmentProvenanceError(f"Raw path references locked segment: {path}")

    if not resolved.is_file():
        raise DevelopmentProvenanceError(f"Dataset path is not a file: {resolved}")
    return resolved


def _index_authorized_source(source_path: Path) -> dict[str, dict[str, Any]]:
    items = _load_jsonl(source_path)
    index: dict[str, dict[str, Any]] = {}
    for item in items:
        issues = verify_item_provenance(item)
        if issues:
            raise DevelopmentProvenanceError(
                f"Authorized source contains invalid provenance for {item.get('id')}: {issues}",
            )
        index[str(item["id"])] = item
    return index


def assert_authorized_source_path(source_path: Path) -> Path:
    resolved = _reject_locked_or_escape(source_path)
    # Allow any *.jsonl directly under DEV_DIR (never locked).
    if _is_under(resolved, DEV_DIR) and resolved.suffix == ".jsonl":
        return resolved
    authorized = {p.resolve() for p in AUTHORIZED_DEV_SOURCES if p.exists()}
    if resolved in authorized:
        return resolved
    raise DevelopmentProvenanceError(
        f"Source is not an authorized development dataset under {DEV_DIR}: {resolved}",
    )


def validate_direct_development_dataset(path: Path) -> dict[str, Any]:
    """Validate a JSONL that itself lives under datasets/dev."""
    resolved = _reject_locked_or_escape(path)
    if not _is_under(resolved, DEV_DIR):
        raise DevelopmentProvenanceError(
            f"Direct development datasets must live under {DEV_DIR}, got {resolved}",
        )
    items = _load_jsonl(resolved)
    if not items:
        raise DevelopmentProvenanceError(f"Empty development dataset: {resolved}")
    for item in items:
        issues = verify_item_provenance(item)
        if issues:
            raise DevelopmentProvenanceError(
                f"Item {item.get('id')} failed provenance checks: {issues}",
            )
    return {
        "ok": True,
        "mode": "direct_dev",
        "datasetPath": str(resolved),
        "itemCount": len(items),
        "contentHash": dataset_content_hash(items),
        "sourceDatasetPath": str(resolved),
    }


def validate_generated_selection(
    selection_path: Path,
    *,
    manifest_path: Path | None = None,
) -> dict[str, Any]:
    """Validate a temp stratified selection against its manifest + authorized source."""
    resolved = _reject_locked_or_escape(selection_path)
    manifest_file = manifest_path or (resolved.parent / "stratified_selection_manifest.json")
    if not manifest_file.exists():
        raise DevelopmentProvenanceError(
            f"Generated selection requires stratified_selection_manifest.json beside {resolved}",
        )
    # Manifest must not be a symlink into locked.
    manifest_resolved = _reject_locked_or_escape(manifest_file)

    try:
        manifest = json.loads(manifest_resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DevelopmentProvenanceError(f"Tampered or invalid selection manifest JSON: {exc}") from exc

    if manifest.get("selectionVersion") != SELECTION_VERSION:
        raise DevelopmentProvenanceError(
            f"Unsupported or forged selectionVersion: {manifest.get('selectionVersion')!r}",
        )
    if manifest.get("access") != "development_only" or manifest.get("lockedAccess") is not False:
        raise DevelopmentProvenanceError("Manifest must declare development_only access")
    if not manifest.get("ok"):
        raise DevelopmentProvenanceError("Manifest records failed selection (ok=false)")

    source_raw = manifest.get("sourceDatasetPath")
    if not source_raw:
        raise DevelopmentProvenanceError("Manifest missing sourceDatasetPath")
    source_path = assert_authorized_source_path(Path(str(source_raw)))

    expected_source_sha = manifest.get("sourceDatasetSha256")
    actual_source_sha = _sha256_file(source_path)
    if not expected_source_sha or expected_source_sha != actual_source_sha:
        raise DevelopmentProvenanceError(
            "sourceDatasetSha256 mismatch (tampered manifest or changed source)",
        )

    source_index = _index_authorized_source(source_path)
    items = _load_jsonl(resolved)
    if not items:
        raise DevelopmentProvenanceError("Generated selection is empty")

    content_hash = dataset_content_hash(items)
    if content_hash != manifest.get("contentHash"):
        raise DevelopmentProvenanceError(
            "Selection contentHash does not match manifest (tampered selection)",
        )

    manifest_ids = manifest.get("itemIds")
    if not isinstance(manifest_ids, list) or not manifest_ids:
        # Fall back to flattened cell itemIds
        cell_ids: list[str] = []
        for cell in manifest.get("cells") or []:
            cell_ids.extend(cell.get("itemIds") or [])
        manifest_ids = cell_ids
    if sorted(manifest_ids) != sorted(item["id"] for item in items):
        raise DevelopmentProvenanceError("Manifest itemIds do not match selection file IDs")

    if int(manifest.get("itemCount") or -1) != len(items):
        raise DevelopmentProvenanceError("Manifest itemCount does not match selection length")

    for item in items:
        issues = verify_item_provenance(item)
        if issues:
            raise DevelopmentProvenanceError(
                f"Selection item {item.get('id')} failed provenance: {issues}",
            )
        item_id = str(item["id"])
        if item_id not in source_index:
            raise DevelopmentProvenanceError(f"Selection item not in authorized source: {item_id}")
        src = source_index[item_id]
        if src.get("contentDigest") != item.get("contentDigest"):
            raise DevelopmentProvenanceError(
                f"contentDigest mismatch for {item_id} vs authorized source",
            )
        if src.get("prompt") != item.get("prompt") or src.get("expected") != item.get("expected"):
            raise DevelopmentProvenanceError(
                f"Item body mismatch for {item_id} vs authorized source",
            )
        if item.get("family") not in ID_FAMILIES or item.get("difficulty") not in DIFFICULTIES:
            raise DevelopmentProvenanceError(f"Invalid family/difficulty for {item_id}")

    return {
        "ok": True,
        "mode": "generated_selection",
        "datasetPath": str(resolved),
        "manifestPath": str(manifest_resolved),
        "itemCount": len(items),
        "contentHash": content_hash,
        "sourceDatasetPath": str(source_path),
        "sourceDatasetSha256": actual_source_sha,
        "selectionVersion": SELECTION_VERSION,
    }


def assert_authorized_development_dataset(
    path: Path,
    *,
    manifest_path: Path | None = None,
) -> dict[str, Any]:
    """Accept direct ``datasets/dev`` JSONL or a verified generated selection."""
    resolved_probe = path if path.exists() else path
    # Fast locked rejection on raw path
    if "locked" in {p.lower() for p in Path(str(path)).parts}:
        raise DevelopmentProvenanceError(f"Locked dataset paths are forbidden: {path}")

    if path.exists() and _is_under(path.resolve(), DEV_DIR):
        return validate_direct_development_dataset(path)

    # Generated selection path (tmp or elsewhere) — require manifest binding
    sibling_manifest = (path.parent / "stratified_selection_manifest.json") if path.parent else None
    if manifest_path or (sibling_manifest and sibling_manifest.exists()):
        return validate_generated_selection(path, manifest_path=manifest_path)

    # No manifest and not under DEV_DIR
    raise DevelopmentProvenanceError(
        f"Unauthorized development dataset path {resolved_probe}. "
        f"Use a file under {DEV_DIR} or a stratified selection with a verified manifest.",
    )


# Back-compat alias used by older call sites.
def assert_development_only(path: Path, *, manifest_path: Path | None = None) -> dict[str, Any]:
    return assert_authorized_development_dataset(path, manifest_path=manifest_path)
