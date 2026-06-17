"""release.yaml — the PR-reviewed declaration of WHAT a release ships.

Carries intent only (which trains, which version, which stage). The orchestrator
consumes it; nothing here touches infra. Secret VALUES never live here — only
non-secret references.

Shape::

    oss:     {release: true,  version: 0.9.6}      # train A (lockstep SDKs+CLI+core)
    cloud:   {deploy:  true,  stage:  dev}         # train B (deploy a SHA to a stage)
    runner:  {rollout: false, stage:  dev}         # train C (in-place SSM)
"""
from __future__ import annotations

import re
from dataclasses import dataclass

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")
ALLOWED_STAGES = {"dev", "prod"}
TRAINS = ("oss", "cloud", "runner")


@dataclass(frozen=True)
class ManifestError:
    field: str
    message: str

    def __str__(self) -> str:
        return f"{self.field}: {self.message}"


def validate(data) -> list[ManifestError]:
    """Return a list of errors. Empty list == valid manifest."""
    if not isinstance(data, dict):
        return [ManifestError("<root>", "manifest must be a mapping")]

    errors: list[ManifestError] = []

    for key in sorted(set(data) - set(TRAINS)):
        errors.append(ManifestError(key, "unknown top-level key (allowed: oss/cloud/runner)"))

    enabled = enabled_trains(data)

    oss = data.get("oss") or {}
    if not isinstance(oss, dict):
        errors.append(ManifestError("oss", "must be a mapping"))
    elif oss.get("release"):
        version = oss.get("version")
        if not version:
            errors.append(ManifestError("oss.version", "required when oss.release is true"))
        elif not SEMVER_RE.match(str(version)):
            errors.append(ManifestError("oss.version", f"not a valid semver: {version!r}"))

    cloud = data.get("cloud") or {}
    if not isinstance(cloud, dict):
        errors.append(ManifestError("cloud", "must be a mapping"))
    elif cloud.get("deploy"):
        errors += _check_stage("cloud.stage", cloud.get("stage"))

    runner = data.get("runner") or {}
    if not isinstance(runner, dict):
        errors.append(ManifestError("runner", "must be a mapping"))
    elif runner.get("rollout"):
        errors += _check_stage("runner.stage", runner.get("stage"))

    if not enabled and not errors:
        errors.append(
            ManifestError(
                "<root>",
                "no train enabled (need one of oss.release / cloud.deploy / runner.rollout)",
            )
        )

    return errors


def _check_stage(field: str, stage) -> list[ManifestError]:
    if not stage:
        return [ManifestError(field, "required when its train is enabled")]
    if stage not in ALLOWED_STAGES:
        return [ManifestError(field, f"unknown stage {stage!r} (allowed: {sorted(ALLOWED_STAGES)})")]
    return []


def enabled_trains(data) -> list[str]:
    """Which trains this manifest activates, in fan-out order (oss, cloud, runner)."""
    out = []
    if isinstance(data, dict):
        if (data.get("oss") or {}).get("release"):
            out.append("oss")
        if (data.get("cloud") or {}).get("deploy"):
            out.append("cloud")
        if (data.get("runner") or {}).get("rollout"):
            out.append("runner")
    return out


def load(path) -> dict:
    import yaml

    with open(path) as handle:
        return yaml.safe_load(handle) or {}
