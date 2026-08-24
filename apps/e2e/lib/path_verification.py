"""Helpers that prove a test actually went through the SDK → API → Runner
chain, instead of accidentally degrading to local FFI.

The standard recipe in `test_path_verification.py`:

    from lib.path_verification import api_hits_for_box, runner_hits_for_box

    @pytest_asyncio.fixture
    async def box_and_paths(box):
        api_before = api_log_seek()
        runner_before = runner_journal_seek()
        yield box
        api_hits = api_hits_for_box(api_before, box.id)
        runner_hits = runner_hits_for_box(runner_before, box.id)
        assert api_hits >= 1, "no API requests carried this box id"
        assert runner_hits >= 1, "no runner journal entries carried this box id"

Backed by:
  - /var/log/boxlite-api.log  (API access log; written by Pino logger
    in boxlite-api.service)
  - journalctl -u boxlite-runner  (runner stdout/stderr; one line per job
    via zerolog)

These are filesystem-level and do not need root, just read access on the
log file. journalctl needs the user in the `systemd-journal` group or
sudo; in CI we run the tests as the same user that owns the service.
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

API_LOG = Path(os.environ.get("BOXLITE_E2E_API_LOG", "/var/log/boxlite-api.log"))
RUNNER_UNIT = os.environ.get("BOXLITE_E2E_RUNNER_UNIT", "boxlite-runner")


def api_log_seek() -> int:
    """Return the current size of the API log. Use this as a 'since' offset
    before the test, then `api_hits_for_box(offset, box_id)` after."""
    try:
        return API_LOG.stat().st_size
    except FileNotFoundError:
        return 0


def api_hits_for_box(since_offset: int, box_id: str) -> int:
    """Count API log lines after `since_offset` that mention `box_id`."""
    if not API_LOG.exists():
        return 0
    with API_LOG.open("rb") as f:
        f.seek(since_offset)
        tail = f.read().decode("utf-8", errors="replace")
    return tail.count(box_id)


def runner_journal_seek() -> str:
    """Return an ISO timestamp to use as `--since` for journalctl."""
    return time.strftime("%Y-%m-%d %H:%M:%S")


def runner_hits_for_box(since_timestamp: str, box_id: str) -> int:
    """Count runner journal lines since `since_timestamp` that mention `box_id`."""
    try:
        proc = subprocess.run(
            ["journalctl", "-u", RUNNER_UNIT, "--since", since_timestamp,
             "--no-pager"],
            capture_output=True, text=True, timeout=15,
        )
    except FileNotFoundError:
        return 0
    if proc.returncode != 0:
        # Some envs need sudo for journalctl; fall back to sudo if present.
        try:
            proc = subprocess.run(
                ["sudo", "journalctl", "-u", RUNNER_UNIT, "--since",
                 since_timestamp, "--no-pager"],
                capture_output=True, text=True, timeout=15,
            )
        except FileNotFoundError:
            return 0
    return proc.stdout.count(box_id)
