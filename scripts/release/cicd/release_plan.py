"""release-plan — the read-only "plan" half of plan/apply.

Runs every pre-apply gate against a manifest + the build's artifact manifest +
the deploy "evidence" (sst diff text, migrations-table state, planned DNS), and
returns a plan report (can_apply / blocked_by / warnings). It NEVER mutates
anything — safe to run on a laptop as a dry-run.

In CI the evidence comes from real `sst diff` / a DB query / a DNS list; for
local dry-run and tests, pass fixtures.
"""
from __future__ import annotations

from cicd import artifact_manifest as am
from cicd import manifest as m
from cicd import preflight as pf

INFRA_TRAINS = {"cloud", "runner"}


def plan(
    manifest_data,
    *,
    artifact_manifest_data=None,
    sst_diff_text: str = "",
    migrations_in_db=None,
    expected_baseline=None,
    planned_dns=None,
    owned_dns=None,
    stage: str | None = None,
    allow_infra_change: bool = False,
) -> dict:
    report = {"can_apply": True, "blocked_by": [], "warnings": [], "trains": []}

    # 1. Manifest must be valid — short-circuit, nothing else is meaningful.
    manifest_errors = m.validate(manifest_data)
    if manifest_errors:
        report["can_apply"] = False
        report["blocked_by"] += [f"manifest: {e}" for e in manifest_errors]
        return report

    report["trains"] = m.enabled_trains(manifest_data)
    if stage is None:
        stage = (manifest_data.get("cloud") or {}).get("stage") or (
            manifest_data.get("runner") or {}
        ).get("stage")

    # 2. Artifact manifest (if supplied) must be valid — deploy trusts it.
    if artifact_manifest_data is not None:
        for err in am.validate(artifact_manifest_data):
            report["can_apply"] = False
            report["blocked_by"].append(f"artifact-manifest: {err}")

    # 3. Infra gates only matter when an infra-touching train is enabled.
    if INFRA_TRAINS & set(report["trains"]):
        _merge(report, pf.resource_gate(pf.parse_sst_diff(sst_diff_text), allow_infra_change), "resource")

        if "cloud" in report["trains"] and migrations_in_db is not None and expected_baseline is not None:
            _merge(report, pf.db_baseline_gate(migrations_in_db, expected_baseline), "db-baseline")

        if planned_dns and owned_dns is not None and stage:
            _merge(report, pf.dns_preflight(planned_dns, owned_dns, stage), "dns")

    return report


def _merge(report: dict, verdict: pf.Verdict, gate: str) -> None:
    if verdict.blocked:
        report["can_apply"] = False
        report["blocked_by"] += [f"{gate}: {r}" for r in verdict.reasons]
    report["warnings"] += [f"{gate}: {w}" for w in verdict.warnings]
