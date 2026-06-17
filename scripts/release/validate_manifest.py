#!/usr/bin/env python3
"""Validate a release.yaml manifest. Exit 0 if valid, 1 if not.

Usage:
    python3 scripts/release/validate_manifest.py release.yaml
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cicd import manifest as m  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: validate_manifest.py <release.yaml>", file=sys.stderr)
        return 2
    path = argv[1]
    try:
        data = m.load(path)
    except FileNotFoundError:
        print(f"error: file not found: {path}", file=sys.stderr)
        return 2

    errors = m.validate(data)
    if errors:
        print(f"INVALID release manifest ({len(errors)} error(s)):", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    trains = m.enabled_trains(data)
    print(f"OK: valid manifest, trains = {', '.join(trains) or '(none)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
