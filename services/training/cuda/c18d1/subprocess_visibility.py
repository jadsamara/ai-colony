#!/usr/bin/env python3
"""Failure visibility for C1.8D backend subprocesses."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Sequence


def last_n_lines(text: str | None, n: int = 40) -> list[str]:
    if not text:
        return []
    lines = text.splitlines()
    return lines[-n:] if len(lines) > n else lines


def run_visible_subprocess(
    cmd: Sequence[str],
    *,
    output_dir: Path,
    log_stem: str = "subprocess",
    cwd: str | Path | None = None,
) -> dict[str, Any]:
    """Run a subprocess; always persist full logs; on failure expose last 40 lines."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = output_dir / f"{log_stem}.stdout.log"
    stderr_path = output_dir / f"{log_stem}.stderr.log"
    meta_path = output_dir / f"{log_stem}.meta.json"
    try:
        proc = subprocess.run(
            list(cmd),
            check=False,
            capture_output=True,
            text=True,
            cwd=str(cwd) if cwd else None,
        )
    except OSError as exc:
        payload = {
            "ok": False,
            "error": f"failed_to_exec: {exc}",
            "cmd": list(cmd),
            "returncode": None,
            "stdoutLog": str(stdout_path),
            "stderrLog": str(stderr_path),
            "stderrLast40Lines": [str(exc)],
        }
        meta_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        return payload

    stdout_path.write_text(proc.stdout or "", encoding="utf-8")
    stderr_path.write_text(proc.stderr or "", encoding="utf-8")
    ok = proc.returncode == 0
    payload: dict[str, Any] = {
        "ok": ok,
        "cmd": list(cmd),
        "returncode": int(proc.returncode),
        "stdoutLog": str(stdout_path),
        "stderrLog": str(stderr_path),
        "stdoutLast40Lines": last_n_lines(proc.stdout, 40),
        "stderrLast40Lines": last_n_lines(proc.stderr, 40),
    }
    if not ok:
        payload["error"] = f"subprocess_failed_rc={proc.returncode}"
    meta_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload
