"""Release ledger — the durable record of what shipped where.

GitHub Actions logs expire (~7 days); promote-by-SHA and rollback need a durable
answer to "what SHA is live in <stage> right now and who approved it". Each apply
appends one entry; ``last_good_sha`` powers Cloud rollback (redeploy last-good).

The ledger is a JSON-lines file (one entry per line) so appends are cheap and
the whole history is greppable.
"""
from __future__ import annotations

import json


def append(path, entry: dict) -> None:
    """Append one release entry (JSON line)."""
    required = ("version", "stage", "sha", "ts")
    missing = [k for k in required if not entry.get(k)]
    if missing:
        raise ValueError(f"ledger entry missing required fields: {missing}")
    with open(path, "a") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


def read(path) -> list[dict]:
    try:
        with open(path) as handle:
            return [json.loads(line) for line in handle if line.strip()]
    except FileNotFoundError:
        return []


def last_good_sha(path, stage: str) -> str | None:
    """Most recent SHA for ``stage`` whose smoke verdict passed.

    "Good" = smoke == "passed". A failed/blocked deploy never becomes the
    rollback target, so a bad ship can't poison last-good.
    """
    good = None
    for entry in read(path):
        if entry.get("stage") == stage and entry.get("smoke") == "passed":
            good = entry.get("sha")  # entries are appended in time order; keep latest
    return good


def current(path, stage: str) -> dict | None:
    """Latest entry for ``stage`` regardless of smoke verdict (what was last attempted)."""
    latest = None
    for entry in read(path):
        if entry.get("stage") == stage:
            latest = entry
    return latest
