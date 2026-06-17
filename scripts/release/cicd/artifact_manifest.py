"""Artifact Manifest — the immutable record produced ONCE by the build factory.

Every downstream consumer (PR preflight e2e, dev deploy, OSS publish, prod
promote) reads ONLY this and pins artifacts by digest. This is what makes the
whole pipeline "build-once, promote-the-digest" instead of rebuild-per-stage.
"""
from __future__ import annotations

import re

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
KINDS = {"oss", "cloud-image", "runner-binary", "agent-image"}


def build(version: str, commit: str, artifacts: list[dict], created_by: str = "") -> dict:
    """Assemble a manifest dict. Does not validate — call :func:`validate`."""
    return {
        "schema": 1,
        "version": version,
        "commit": commit,
        "created_by": created_by,
        "artifacts": list(artifacts),
    }


def validate(data) -> list[str]:
    """Return list of error strings. Empty == valid."""
    if not isinstance(data, dict):
        return ["manifest must be a mapping"]

    errors: list[str] = []
    if not data.get("version"):
        errors.append("version: required")
    if not data.get("commit"):
        errors.append("commit: required")

    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("artifacts: must be a non-empty list")
        return errors

    seen: set[str] = set()
    for idx, art in enumerate(artifacts):
        where = f"artifacts[{idx}]"
        if not isinstance(art, dict):
            errors.append(f"{where}: must be a mapping")
            continue
        name = art.get("name")
        if not name:
            errors.append(f"{where}.name: required")
        elif name in seen:
            errors.append(f"{where}.name: duplicate {name!r}")
        else:
            seen.add(name)
        if art.get("kind") not in KINDS:
            errors.append(f"{where}.kind: must be one of {sorted(KINDS)} (got {art.get('kind')!r})")
        digest = art.get("digest", "")
        if not DIGEST_RE.match(str(digest)):
            errors.append(f"{where}.digest: must match sha256:<64 hex> (got {digest!r})")
        if not art.get("location"):
            errors.append(f"{where}.location: required")
    return errors


def find(data, name: str) -> dict | None:
    for art in data.get("artifacts", []):
        if isinstance(art, dict) and art.get("name") == name:
            return art
    return None
