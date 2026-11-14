#!/usr/bin/env python3
"""CPU-only full blind-audit preparation after Gemma smoke pass.

1. Reconcile weak-family grader_miss samples (historical vs remaining)
2. Verify dataset / saved-prompt provenance
3. Confirm audit composition (all failures + stratified 10% corrects)
4. Confirm blindness (no expected/grades in reviewer payloads)
5. Emit runtime + disk estimates from smoke metrics
6. Write gated runner instructions (do not execute GPU here)

Does not launch Gemma serve / 307-case audit / pilot / Stage B / training.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

from blind_llm_audit import (
    AUDIT_DESIGN,
    SMOKE_OBSERVED_METRICS,
    estimate_runtime_from_smoke,
    prepare_audit,
)
from grader_miss_reconcile import (
    RECONCILE_VERSION,
    build_synthetic_ten_miss_fixture,
    reconcile_weak_family_audit,
)
from reviewer_gemma3 import PINNED_GEMMA3_27B_IT

PREPARE_VERSION = "c18d1-full-blind-audit-prepare-v1"


def check_disk(path: Path, *, recommended_free_gib: float = 5.0) -> dict[str, Any]:
    usage = shutil.disk_usage(path)
    free_gib = usage.free / (1024**3)
    return {
        "path": str(path.resolve()),
        "freeGiB": round(free_gib, 2),
        "totalGiB": round(usage.total / (1024**3), 2),
        "recommendedFreeGiB": recommended_free_gib,
        "sufficientForAuditOutputs": free_gib >= recommended_free_gib,
        "modelCacheReuse": (
            "Require pinned Gemma revision already in HF cache; "
            "full-audit script uses local_files_only first (no redownload)."
        ),
        "pinnedRevision": PINNED_GEMMA3_27B_IT["modelRevision"],
    }


def prepare_full_audit_bundle(
    *,
    output_dir: Path,
    regrade_report_path: Path | None = None,
    dataset_path: Path | None = None,
    weak_family_audit_path: Path | None = None,
    seed: int = 18,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    c18d1 = Path(__file__).resolve().parent
    historical = c18d1 / "datasets" / "historical" / "id_dev.gen-v2.jsonl"
    dataset_path = dataset_path or historical

    # --- 1. Grader-miss reconcile ---
    if weak_family_audit_path and weak_family_audit_path.is_file():
        weak = json.loads(weak_family_audit_path.read_text(encoding="utf-8"))
        weak_source = str(weak_family_audit_path.resolve())
        used_fixture = False
    else:
        weak = build_synthetic_ten_miss_fixture()
        weak_source = "synthetic_ten_miss_fixture"
        used_fixture = True
    reconcile = reconcile_weak_family_audit(weak)
    reconcile["sourcePath"] = weak_source
    reconcile["usedSyntheticFixture"] = used_fixture
    (output_dir / "grader-miss-reconcile.json").write_text(
        json.dumps(reconcile, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    # --- 2–4. Blind audit prepare (composition, provenance, blindness) ---
    blind_dir = output_dir / "blind-audit"
    if regrade_report_path and regrade_report_path.is_file():
        manifest = prepare_audit(
            regrade_report_path=regrade_report_path,
            dataset_path=dataset_path,
            output_dir=blind_dir,
            seed=seed,
        )
        packets_ready = True
    else:
        # No VM regrade yet — still emit design + smoke-calibrated estimates.
        runtime = estimate_runtime_from_smoke(AUDIT_DESIGN["expectedCaseCount"])
        manifest = {
            "ok": False,
            "mode": "prepare_pending_regrade_artifacts",
            "error": "regrade_report_missing",
            "expectedCaseCount": AUDIT_DESIGN["expectedCaseCount"],
            "auditDesign": AUDIT_DESIGN,
            "runtimeEstimate": runtime,
            "smokeObserved": SMOKE_OBSERVED_METRICS,
            "datasetPath": str(dataset_path.resolve()) if dataset_path.is_file() else None,
            "note": (
                "Run offline regrade on the GPU VM noise-floor dir, then re-run this "
                "prepare with --regrade-report to materialize the 307-case packets."
            ),
            "gpuWorkloadAuthorized": False,
            "fullAuditExecuted": False,
        }
        blind_dir.mkdir(parents=True, exist_ok=True)
        (blind_dir / "blind-audit-manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        packets_ready = False

    disk = check_disk(output_dir)
    runtime = manifest.get("runtimeEstimate") or estimate_runtime_from_smoke()

    # Prepare succeeds when reconcile + estimates land. Packet materialization
    # additionally requires a regrade report (flagged separately as packetsReady).
    summary = {
        "ok": bool(reconcile.get("ok"))
        and (not packets_ready or bool(manifest.get("ok"))),
        "prepareVersion": PREPARE_VERSION,
        "reconcileVersion": RECONCILE_VERSION,
        "smokeObserved": SMOKE_OBSERVED_METRICS,
        "smokeStatus": "passed_operator_reported",
        "graderMissReconcile": {
            "inputMissCount": reconcile.get("inputMissCount"),
            "historicalCorrectedCount": reconcile.get("historicalCorrectedCount"),
            "remainingDefectCount": reconcile.get("remainingDefectCount"),
            "openStageBBlockerCount": reconcile.get("openStageBBlockerCount"),
            "usedSyntheticFixture": used_fixture,
            "byDefectKind": reconcile.get("byDefectKind"),
            "reportPath": str((output_dir / "grader-miss-reconcile.json").resolve()),
        },
        "blindAudit": {
            "packetsReady": packets_ready,
            "packetCount": manifest.get("packetCount"),
            "expectedCaseCount": manifest.get("expectedCaseCount")
            or AUDIT_DESIGN["expectedCaseCount"],
            "composition": manifest.get("composition"),
            "datasetProvenance": manifest.get("datasetProvenance"),
            "blindness": manifest.get("blindness"),
            "manifestPath": str((blind_dir / "blind-audit-manifest.json").resolve()),
        },
        "runtimeEstimate": runtime,
        "disk": disk,
        "pinnedGemma": PINNED_GEMMA3_27B_IT,
        "execution": {
            "gpuWorkloadAuthorized": False,
            "fullAuditExecuted": False,
            "gate": (
                "After reviewing this prepare bundle, on the GPU VM: "
                "export C18D1_LLM_AUDIT_CONFIRM=1 && ./scripts/c18d1-gpu-gemma-full-audit. "
                "Script reuses HF cache (local_files_only). Do not run from Mac."
            ),
            "blocked": [
                "307-case audit execution (needs separate confirmation on GPU VM)",
                "stratified pilot",
                "Stage B",
                "training",
                "promotion",
            ],
        },
        "policy": [
            "Gemma receives only problemStatement + rawModelResponse before judgment",
            "Gemma judgments are not ground truth",
            "historical_corrected grader misses are not open Stage B blockers",
            "remaining_defect still blocks Stage B until versioned fix",
            "Reuse pinned HF cache; do not redownload weights",
        ],
    }
    (output_dir / "full-blind-audit-prepare-report.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--regrade-report", type=Path, default=None)
    parser.add_argument("--dataset", type=Path, default=None)
    parser.add_argument("--weak-family-audit", type=Path, default=None)
    parser.add_argument("--seed", type=int, default=18)
    args = parser.parse_args()
    summary = prepare_full_audit_bundle(
        output_dir=args.out,
        regrade_report_path=args.regrade_report,
        dataset_path=args.dataset,
        weak_family_audit_path=args.weak_family_audit,
        seed=args.seed,
    )
    print(
        json.dumps(
            {
                "ok": summary["ok"],
                "prepareVersion": summary["prepareVersion"],
                "graderMissReconcile": summary["graderMissReconcile"],
                "packetsReady": summary["blindAudit"]["packetsReady"],
                "packetCount": summary["blindAudit"]["packetCount"],
                "runtimeMinutesSerial": (
                    summary.get("runtimeEstimate") or {}
                ).get("estimatedTotalGpuMinutesSerial"),
                "diskFreeGiB": summary["disk"]["freeGiB"],
                "out": str(args.out / "full-blind-audit-prepare-report.json"),
            },
            indent=2,
        ),
    )


if __name__ == "__main__":
    main()
