"""E2E port of `src/boxlite/tests/execution_shutdown.rs`.

Verifies the behaviour of exec and box state during/after box.stop():
pending exec.wait() should resolve, new exec attempts on a stopped
box with auto-resume disabled should be cleanly rejected (HTTP 409).
"""
from __future__ import annotations

import asyncio

import boxlite
import pytest

from conftest import wait_for_box_state
from e2e_auth import auth_context, request_json


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
    """Disabled auto-resume refuses stopped exec through both SDK and HTTP."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False, auto_resume=False))
    try:
        ctx = auth_context()
        status, body = request_json("GET", ctx.v1(f"boxes/{box.id}"))
        assert status == 200 and body["auto_resume"] is False
        await box.stop()
        await wait_for_box_state(rt, box.id, "stopped")

        with pytest.raises((boxlite.InvalidStateError, boxlite.StoppedError)):
            await box.exec("echo", ["must-not-run"])

        status, body = request_json(
            "POST", ctx.v1(f"boxes/{box.id}/exec"),
            {"command": "echo", "args": ["must-not-run"]},
        )
        assert status == 409, f"stopped exec returned HTTP {status}: {body}"
        assert (await rt.get_info(box.id)).state.status == "stopped"
    finally:
        try:
            await rt.remove(box.id, force=True)
        except Exception:
            pass
