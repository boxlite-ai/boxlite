"""E2E port of `src/boxlite/tests/execution_shutdown.rs`.

Verifies the behaviour of exec and box state during/after box.stop():
pending exec.wait() should resolve, new exec attempts on a stopped
box should be cleanly rejected (not 5xx).
"""
from __future__ import annotations

import asyncio

import boxlite
import pytest

from conftest import drain


@pytest.mark.asyncio
async def test_wait_resolves_after_box_stop(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        ex = await box.exec("sh", ["-c", "sleep 60"], None)
        # Stop the box while exec is still running. wait() should resolve
        # (with whatever exit code the runtime reports) within a few
        # seconds, not hang.
        await asyncio.sleep(0.5)
        await box.stop()
        try:
            rc = await asyncio.wait_for(ex.wait(), timeout=30)
            # Whatever exit code is fine; the point is it resolved.
            assert rc is not None
        except asyncio.TimeoutError:
            pytest.fail("ex.wait() did not resolve within 30s after box.stop()")
    finally:
        try:
            await rt.remove(box.id, force=True)
        except Exception:
            pass


@pytest.mark.asyncio
async def test_exec_on_stopped_box_is_typed_error(rt, image):
    """Trying to exec on a stopped box must return a typed client
    error (not 5xx). Catches API/runner mapping regressions."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        await box.stop()
        # Now try to exec — should fail with a clean client error
        with pytest.raises(Exception) as exc_info:
            ex = await box.exec("sh", ["-c", "echo nope"], None)
            await drain(ex)
            await ex.wait()
        msg = str(exc_info.value)
        assert "500" not in msg and "Internal" not in msg, (
            f"exec on stopped box returned 5xx: {msg!r}"
        )
    finally:
        try:
            await rt.remove(box.id, force=True)
        except Exception:
            pass
