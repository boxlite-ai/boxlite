"""E2E coverage of CLI detach + state survival.

`boxlite run -d` returns a box id, leaves the box running in the
runner, and lets the CLI process exit. A fresh invocation from a brand
new CLI process must:

  1. see the detached box in `boxlite ls`
  2. exec into it successfully
  3. report consistent state on `boxlite info`

These behaviours are covered for local FFI by `src/boxlite/tests/
detach.rs` and `recovery.rs`. Nothing covers the API + runner-state
side end-to-end — a regression where the API loses the box record on
runner restart, or where the runner journal misses the box, would
silently break detach for every user.

Approach: spawn separate `subprocess.run` invocations so each call gets
its own fresh CLI process. We never reuse a long-lived Python SDK
handle — that defeats the point of testing detach survival.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[4] / "scripts" / "test" / "e2e" / "lib"),
)
from path_verification import runner_journal_seek, runner_hits_for_box

BOXLITE_BIN = os.environ.get("BOXLITE_E2E_CLI", shutil.which("boxlite"))
IMAGE = os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23")
UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)


@pytest.fixture(scope="module")
def cli():
    if not BOXLITE_BIN or not Path(BOXLITE_BIN).exists():
        pytest.skip(f"boxlite CLI not found at {BOXLITE_BIN!r}")
    return BOXLITE_BIN


def run(cli, *args, timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        [cli, *args], timeout=timeout, text=True, capture_output=True, check=check,
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Step 3 (`boxlite exec <id> -- sh -c 'echo still-alive'`) returns "
        "empty stdout — same stdout-drop race that #563 fixes (the CLI's "
        "exec command goes through libboxlite's drain path). Steps 1 + 2 "
        "(detach run + ls verify) work today. When #563 lands the assertion "
        "`'still-alive' in r_exec.stdout` starts holding and this xfail "
        "flips xpass-strict — drop the marker then."
    ),
)
def test_detached_box_survives_cli_exit_and_is_reusable(cli):
    """The cycle: detach → CLI exits → fresh CLI invocations still
    see / exec the same box id.

    `boxlite info` is currently system-wide (version / runtime stats),
    not per-box, so we don't try to query the box via `info <id>` here
    — `boxlite ls` already proves the runtime knows about it, and the
    subsequent `exec` proves it's still usable. Add a per-box info
    command and we'll extend the contract."""
    journal_since = runner_journal_seek()

    # 1) detach run in one CLI process
    r_run = run(cli, "run", "-d", IMAGE, "--", "sleep", "300", timeout=120)
    m = UUID_RE.search(r_run.stdout)
    assert m, f"`boxlite run -d` did not print a uuid: {r_run.stdout!r}"
    box_id = m.group(0)

    try:
        # The CLI process from step 1 has already exited by the time
        # subprocess.run returned, so steps 2/3 each start fresh.

        # 2) fresh CLI: ls sees the box, and the row shows it Running
        r_ls = run(cli, "ls")
        assert box_id in r_ls.stdout, (
            f"detached box {box_id} not visible after CLI exit: {r_ls.stdout}"
        )
        # Find the box's row and check it advertises a non-empty state.
        # The CLI's ls renders a Unicode table; we grep the row by id
        # and ensure it contains a status keyword (Running / Started /
        # Ready / Configured — varies by build).
        ls_row = next(
            (ln for ln in r_ls.stdout.splitlines() if box_id in ln), ""
        )
        assert any(
            kw in ls_row for kw in ("Running", "Started", "Ready", "Configured")
        ), (
            f"`boxlite ls` row for {box_id} has no recognisable state: {ls_row!r}"
        )

        # 3) fresh CLI: exec a command into the detached box
        r_exec = run(cli, "exec", box_id, "--", "sh", "-c", "echo still-alive")
        assert "still-alive" in r_exec.stdout, (
            f"exec into detached box failed: {r_exec.stdout!r}"
        )

        # 5) runner journal saw the box id (path-bypass guard)
        hits = runner_hits_for_box(journal_since, box_id)
        assert hits >= 1, (
            f"runner journal did not see detached box {box_id}; "
            f"`boxlite run -d` may have bypassed the API"
        )
    finally:
        run(cli, "rm", "-f", box_id, check=False)


def test_detached_box_exec_propagates_exit_code_on_fresh_cli(cli):
    """A non-zero exit from a command exec'd into a detached box must
    still propagate when the exec is launched from a fresh CLI process
    (i.e. no in-memory SDK state to lean on)."""
    r_run = run(cli, "run", "-d", IMAGE, "--", "sleep", "300", timeout=120)
    m = UUID_RE.search(r_run.stdout)
    assert m
    box_id = m.group(0)

    try:
        r = run(cli, "exec", box_id, "--", "sh", "-c", "exit 5", check=False)
        assert r.returncode == 5, (
            f"CLI did not propagate exec exit code through detach: "
            f"got {r.returncode}, stdout={r.stdout!r} stderr={r.stderr!r}"
        )
    finally:
        run(cli, "rm", "-f", box_id, check=False)
