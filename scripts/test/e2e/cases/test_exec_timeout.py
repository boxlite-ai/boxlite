"""E2E port of `sdks/python/tests/test_exec_timeout_sigalrm.py`.

Verifies that exec timeout kills processes that ignore SIGTERM
(via SIGALRM) and falls back to SIGKILL when needed.
"""
from __future__ import annotations

import asyncio
import time

import boxlite
import pytest

from conftest import drain


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
        await drain(ex)
        t0 = time.time()
        rc = await asyncio.wait_for(ex.wait(), timeout=15)
        elapsed = time.time() - t0
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
        await drain(ex)
        t0 = time.time()
        rc = await asyncio.wait_for(ex.wait(), timeout=15)
        elapsed = time.time() - t0
        assert elapsed < 12, (
            f"SIGTERM-ignoring process not killed within bound; "
            f"elapsed={elapsed:.1f}s"
        )
        assert rc.exit_code != 0
    finally:
        await rt.remove(box.id, force=True)
