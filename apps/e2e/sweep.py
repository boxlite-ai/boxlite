#!/usr/bin/env python3
"""Reclaim boxes an earlier e2e run stranded in a cloud org.

Why this exists: the cloud run against dev (30788880372's predecessor,
30787280531, 2026-08-03) failed 53 tests and errored 12, and every single
failure read "Organization quota exceeded: disk limit exceeded (max 512GB)".
Nothing in the stack reclaims a box whose test process died before teardown —
`auto_remove=True` is a no-op over REST and the API defaults `auto_delete` to
disabled — so the org's disk filled with boxes from runs that had long since
finished, and the suite could not pass no matter what the code did.

`conftest.bound_box_lifetime` stops that happening again for boxes the pytest
cases create. This script is the other half: it clears what earlier runs left
behind.

Scope: boxes in the credential's organization whose name carries this suite's
`e2e-` prefix and that have been idle past the threshold. The prefix is what
makes the sweep attributable — `conftest.e2e_box_name` names every box the
cases create, and without it a maintainer's own long-stopped box is
indistinguishable from a stranded one. A report against dev on 2026-09-21
listed five such boxes (`pol599-repro`, `pol599-after`, …), none of them the
suite's; deleting those would have destroyed someone's investigation.

`--any-name` drops the prefix filter for the cases the prefix cannot cover —
boxes from the polyglot drivers (`apps/e2e/sdks/`) and the CLI, which do not
pass through that fixture. It is deliberately opt-in and not what CI runs.

Staleness comes from `last_activity_at`, falling back to `created_at` for a
box that never recorded any, so a box in use is never a candidate. The default
window is a day — far beyond any run, which the workflow caps at 45 minutes.

    python3 apps/e2e/sweep.py                     # report only
    python3 apps/e2e/sweep.py --apply             # delete what it reports
    python3 apps/e2e/sweep.py --idle-minutes 120  # narrower window
    python3 apps/e2e/sweep.py --any-name          # ignore the name prefix
    python3 apps/e2e/sweep.py --name-prefix foo-   # a different prefix

Credentials come from the same place the suite's fixtures read them
(`apps/e2e/lib/e2e_auth.py`): BOXLITE_E2E_* env vars, else the profile in
~/.boxlite/credentials.toml.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import sys
import time
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

from e2e_auth import auth_context, request_json  # noqa: E402


DEFAULT_IDLE_MINUTES = 24 * 60

# Kept in step with `E2E_BOX_NAME_PREFIX` in apps/e2e/cases/conftest.py, which
# is where the names come from. Not imported from there: that module imports
# the compiled `boxlite` SDK, and this script deliberately runs before the
# wheel is installed (the workflow sweeps before it builds anything).
DEFAULT_NAME_PREFIX = "e2e-"

# How long to wait for the control plane to finish a delete. The API answers
# 204 once the destroy is enqueued, and the runner frees the disk afterwards
# (BoxManager's 10-second reconcile crons), so returning at 204 would report
# quota that is not free yet.
DELETE_SETTLE_SECONDS = 120


def _parse_timestamp(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _idle_since(box: dict) -> datetime | None:
    """When this box was last touched, as the control plane sees it."""
    return _parse_timestamp(box.get("last_activity_at")) or _parse_timestamp(box.get("created_at"))


def _list_boxes() -> list[dict]:
    status, body = request_json("GET", auth_context().v1("boxes"))
    if status != 200:
        raise SystemExit(f"GET boxes returned HTTP {status}: {body}")
    return list((body or {}).get("boxes") or [])


def _delete(box_id: str) -> tuple[int, dict | None]:
    return request_json("DELETE", auth_context().v1(f"boxes/{box_id}"))


def _is_gone(box_id: str) -> bool:
    """True only on a 404.

    Every other status — 401, 429, a 5xx from a stage mid-deploy — says
    nothing about whether the box is gone, and reading it as "gone" would let
    one transient error produce exactly the premature "quota is free" claim
    this polling exists to prevent. A transport error is inconclusive in the
    same way and must not end the loop either: `request_json` raises URLError
    rather than returning a status, and a stage mid-deploy is exactly when
    that happens.
    """
    try:
        status, _ = request_json("GET", auth_context().v1(f"boxes/{box_id}"))
    except urllib.error.URLError:
        return False
    return status == 404


def _wait_until_gone(box_ids: list[str]) -> list[str]:
    """Return the ids not yet confirmed gone when the settle window runs out."""
    deadline = time.monotonic() + DELETE_SETTLE_SECONDS
    pending = list(box_ids)
    while pending and time.monotonic() < deadline:
        pending = [box_id for box_id in pending if not _is_gone(box_id)]
        if pending:
            time.sleep(5)
    return pending


def select_stale(
    boxes: list[dict],
    now: datetime,
    idle_minutes: int,
    name_prefix: str | None,
) -> tuple[list[tuple[dict, float]], int]:
    """Split boxes into (stale, count left alone for not matching the prefix).

    Pure so the rule that decides what gets deleted can be tested without a
    stage: see apps/e2e/cases/test_harness_guards.py.
    """
    stale: list[tuple[dict, float]] = []
    skipped_by_name = 0
    for box in boxes:
        since = _idle_since(box)
        if since is None:
            # No timestamp at all: the box's age is unknown, and guessing it is
            # stale would delete something that might be seconds old.
            continue
        idle = (now - since).total_seconds() / 60
        if idle < idle_minutes:
            continue
        if name_prefix and not str(box.get("name") or "").startswith(name_prefix):
            skipped_by_name += 1
            continue
        stale.append((box, idle))
    return stale, skipped_by_name


def sweep(idle_minutes: int, apply: bool, name_prefix: str | None) -> int:
    """Report — and with `apply`, delete — this suite's stale boxes.

    `name_prefix` of None sweeps regardless of name; see the module docstring
    for why that is opt-in.
    """
    now = datetime.now(timezone.utc)
    boxes = _list_boxes()
    stale, skipped_by_name = select_stale(boxes, now, idle_minutes, name_prefix)

    scope = f"name starts with {name_prefix!r}" if name_prefix else "any name (--any-name)"
    print(
        f"{len(boxes)} box(es) visible to this credential; "
        f"{len(stale)} idle >= {idle_minutes}m and {scope}"
        + (f"; {skipped_by_name} idle box(es) left alone — not this suite's" if skipped_by_name else "")
    )
    for box, idle in sorted(stale, key=lambda item: -item[1]):
        print(
            f"  {box.get('box_id')}  status={box.get('status')}  "
            f"idle={idle:.0f}m  image={box.get('image')}  name={box.get('name')}"
        )

    if not apply:
        if stale:
            print("report only — pass --apply to delete the boxes listed above")
        return 0

    failures = 0
    deleted: list[str] = []
    for box, _ in stale:
        box_id = str(box.get("box_id"))
        status, body = _delete(box_id)
        # 404 means someone (or auto-delete) got there first — the desired end
        # state either way.
        if status in (200, 202, 204, 404):
            print(f"  delete accepted for {box_id} (HTTP {status})")
            deleted.append(box_id)
            continue
        failures += 1
        print(f"  FAILED to delete {box_id}: HTTP {status}: {body}")

    # 204 only means the destroy was enqueued. Quota is freed when the runner
    # has actually torn the box down, so the sweep is not done until the
    # control plane stops serving it.
    pending = _wait_until_gone(deleted)
    if pending:
        print(
            f"{len(pending)} box(es) still present after {DELETE_SETTLE_SECONDS}s: "
            f"{pending} — their disk may still count against the org quota"
        )
    if failures or pending:
        return 1
    print(f"{len(deleted)} box(es) gone")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--idle-minutes",
        type=int,
        default=DEFAULT_IDLE_MINUTES,
        help=f"treat a box idle at least this long as stranded (default {DEFAULT_IDLE_MINUTES})",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="delete the reported boxes instead of only listing them",
    )
    parser.add_argument(
        "--name-prefix",
        default=DEFAULT_NAME_PREFIX,
        help=f"only boxes whose name starts with this (default {DEFAULT_NAME_PREFIX!r})",
    )
    parser.add_argument(
        "--any-name",
        action="store_true",
        help="sweep stale boxes whatever their name — includes boxes this suite did not create",
    )
    args = parser.parse_args()
    if args.idle_minutes < 1:
        parser.error("--idle-minutes must be at least 1")
    # An empty prefix is what an unset shell variable expands to, and it would
    # disable the filter `--apply`'s safety rests on while the report still
    # claimed a prefix. Widening the scope has one spelling: --any-name.
    if not args.any_name and not args.name_prefix:
        parser.error("--name-prefix cannot be empty; pass --any-name to sweep every stale box")
    return sweep(args.idle_minutes, args.apply, None if args.any_name else args.name_prefix)


if __name__ == "__main__":
    raise SystemExit(main())
