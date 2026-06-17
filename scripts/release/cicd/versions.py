"""OSS single-version-source drift check.

The OSS train is lockstep: SDKs (py/node/c) + CLI + core all share ONE version,
sourced from the Cargo workspace. If a site disagrees, the OSS train can ship
mismatched FFI artifacts (segfault class). This is a CHECK (report drift), not a
force-rewrite — it's safe to run anywhere and gates the version-writeback step.

Each extractor takes file *text* so it is trivially testable without a real tree.
"""
from __future__ import annotations

import re

_CARGO_VERSION = re.compile(r'(?m)^\s*version\s*=\s*"([^"]+)"')
_PYPROJECT_VERSION = re.compile(r'(?m)^\s*version\s*=\s*"([^"]+)"')
_JSON_VERSION = re.compile(r'"version"\s*:\s*"([^"]+)"')


def cargo_workspace_version(text: str) -> str | None:
    """First ``version = "..."`` under [workspace.package] / [package]."""
    m = _CARGO_VERSION.search(text)
    return m.group(1) if m else None


def pyproject_version(text: str) -> str | None:
    m = _PYPROJECT_VERSION.search(text)
    return m.group(1) if m else None


def json_version(text: str) -> str | None:
    m = _JSON_VERSION.search(text)
    return m.group(1) if m else None


def set_first_version(text: str, version: str) -> str:
    """Rewrite the first ``version = "..."`` line (Cargo / pyproject TOML).

    Only the version VALUE changes; everything else (formatting, comments,
    other ``version`` keys of dependencies) is left intact because we replace
    a single occurrence. Raises if no version line is present.
    """
    new, n = _CARGO_VERSION.subn(lambda mo: mo.group(0).replace(mo.group(1), version, 1), text, count=1)
    if n == 0:
        raise ValueError('no `version = "..."` line found')
    return new


def set_json_version_text(text: str, version: str) -> str:
    """Rewrite the first ``"version": "..."`` in JSON (package.json)."""
    new, n = _JSON_VERSION.subn(lambda mo: mo.group(0).replace(mo.group(1), version, 1), text, count=1)
    if n == 0:
        raise ValueError('no "version": "..." field found')
    return new


def check_drift(sites: dict[str, str | None], source_of_truth: str = "Cargo.toml") -> list[str]:
    """Compare every site's version against the source-of-truth site.

    sites: {label: version|None}. ``source_of_truth`` must be a key in ``sites``.
    Returns a list of human-readable drift messages (empty == all aligned).
    """
    if source_of_truth not in sites:
        raise ValueError(f"source_of_truth {source_of_truth!r} not in sites {list(sites)}")
    truth = sites[source_of_truth]
    errors: list[str] = []
    if truth is None:
        return [f"{source_of_truth}: version not found (cannot establish source of truth)"]
    for label, version in sites.items():
        if label == source_of_truth:
            continue
        if version is None:
            errors.append(f"{label}: version not found")
        elif version != truth:
            errors.append(f"{label}: {version} != {truth} ({source_of_truth})")
    return errors
