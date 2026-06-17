"""E2E port of `sdks/python/tests/test_exec_timeout_sigalrm.py`.

Verifies that exec timeout kills processes that ignore SIGTERM
(via SIGALRM) and falls back to SIGKILL when needed.

REST-path note: drain() (which collects stdout/stderr to EOF) is moved
behind a short wait_for() because the REST runner's stream pumps don't
reliably observe stream closure when the workload terminates via
SIGKILL — drain() blocks indefinitely on cloud while the underlying
exec has long since exited. The exit-code / elapsed assertions don't
depend on stream content, so a best-effort drain (3s ceiling) is
enough to flush whatever the pump did emit without holding the test
hostage on the missing close signal. Tracked separately under the
REST stream-pump teardown audit; the local FFI path is unaffected.
"""
from __future__ import annotations

import asyncio
import time

import boxlite
import pytest

from conftest import drain


async def _best_effort_drain(ex, timeout: float = 3.0) -> None:
    """Drain stdout / stderr with a short ceiling. See module docstring
    for the REST stream-pump caveat."""
    try:
        await asyncio.wait_for(drain(ex), timeout=timeout)
    except asyncio.TimeoutError:
        # Best-effort only: if stream pumps don't close cleanly, continue
        # without failing this timeout behavior test.
        pass


@pytest.mark.asyncio
async def test_exec_timeout_kills_long_command(rt, image):
    """A command that would run forever is killed after the timeout
    elapses, and the exec returns a nonzero exit code."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec(
            "sh", ["-c", "sleep 300"],
            timeout_secs=2.0,  # seconds
        )
        t0 = time.time()
        rc = await asyncio.wait_for(ex.wait(), timeout=15)
        elapsed = time.time() - t0
        await _best_effort_drain(ex)
        assert elapsed < 10, (
            f"timeout did not fire within bound; elapsed={elapsed:.1f}s"
        )
        assert rc.exit_code != 0, (
            f"timed-out command returned exit=0: should be nonzero"
        )
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_exec_timeout_kills_sigterm_ignoring_process(rt, image):
    """SIGTERM-ignoring process is escalated to SIGKILL by the timeout
    path. Without escalation a `trap : 15` shell would run forever."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec(
            "sh", ["-c", "trap '' TERM; sleep 300"],
            timeout_secs=2.0,
        )
        t0 = time.time()
        rc = await asyncio.wait_for(ex.wait(), timeout=15)
        elapsed = time.time() - t0
        await _best_effort_drain(ex)
        assert elapsed < 12, (
            f"SIGTERM-ignoring process not killed within bound; "
            f"elapsed={elapsed:.1f}s"
        )
        assert rc.exit_code != 0
    finally:
        await rt.remove(box.id, force=True)
