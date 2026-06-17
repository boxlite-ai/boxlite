#!/usr/bin/env python3
"""write-versions CLI — check or align the OSS version across all sites.

OSS is lockstep: one version across Cargo workspace + pyproject + package.json.
Default mode is --check (report drift, exit 1 if any). --write rewrites every
listed site to --version (only the version value changes).

    # check drift against Cargo as source of truth
    python3 scripts/release/write_versions.py --check \
        --cargo Cargo.toml --pyproject sdks/python/pyproject.toml --json sdks/node/package.json

    # align everyone to a new version (use in the version-writeback step)
    python3 scripts/release/write_versions.py --write --version 0.9.6 \
        --cargo Cargo.toml --pyproject sdks/python/pyproject.toml --json sdks/node/package.json
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cicd import versions as v  # noqa: E402

TOML_KINDS = ("cargo", "pyproject")


def _current(kind: str, text: str):
    return v.json_version(text) if kind == "json" else v.cargo_workspace_version(text)


def _rewrite(kind: str, text: str, version: str) -> str:
    return v.set_json_version_text(text, version) if kind == "json" else v.set_first_version(text, version)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Check or align OSS version across sites")
    ap.add_argument("--cargo", action="append", default=[])
    ap.add_argument("--pyproject", action="append", default=[])
    ap.add_argument("--json", action="append", default=[])
    ap.add_argument("--check", action="store_true", help="report drift only (default)")
    ap.add_argument("--write", action="store_true", help="rewrite files to --version")
    ap.add_argument("--version", help="target version (required with --write)")
    args = ap.parse_args(argv[1:])

    sites = [("cargo", p) for p in args.cargo] + [("pyproject", p) for p in args.pyproject] + [
        ("json", p) for p in args.json
    ]
    if not sites:
        print("no sites given (use --cargo/--pyproject/--json)", file=sys.stderr)
        return 2

    if args.write:
        if not args.version:
            print("--write requires --version", file=sys.stderr)
            return 2
        for kind, path in sites:
            text = Path(path).read_text()
            Path(path).write_text(_rewrite(kind, text, args.version))
            print(f"set {path} -> {args.version}")
        return 0

    # --check: Cargo is the source of truth (first cargo site)
    versions = {path: _current(kind, Path(path).read_text()) for kind, path in sites}
    truth_path = args.cargo[0] if args.cargo else sites[0][1]
    drift = v.check_drift(versions, source_of_truth=truth_path)
    if drift:
        print(f"VERSION DRIFT ({len(drift)}):", file=sys.stderr)
        for d in drift:
            print(f"  - {d}", file=sys.stderr)
        return 1
    print(f"OK: all {len(sites)} sites at {versions[truth_path]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
