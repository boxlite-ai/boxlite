"""REST E2E coverage for SimpleBox's exit-time cleanup contract.

`Box.__aexit__` (the Rust FFI layer) only stops the VM. `BoxOptions.auto_remove`
is a deprecated field that REST runtimes silently ignore (see the
`auto_remove` docs on `BoxOptions` in `src/boxlite/src/runtime/options.rs`) -
local runtimes still self-delete on stop when it's set, which is why this
only leaks remotely. If `SimpleBox` doesn't explicitly delete the box itself
on exit, `auto_remove=True` deletes nothing and the box is left `Stopped`
forever on the remote server. This is a regression test for exactly that
leak: every box `test_sdk_tunnel.py` created via `SimpleBox` survived the
whole e2e suite on the dev cloud environment.
"""
from __future__ import annotations

import asyncio
import time

import boxlite
import pytest


async def _box_gone(rt, box_id: str, *, timeout: float = 15.0) -> bool:
    """Poll until get_info reports the box missing, or the timeout elapses.

    The Python SDK has no typed NotFound exception over REST (`map_err`
    collapses every server error to a generic RuntimeError), so absence is
    detected by matching the REST 404 wording in the message rather than an
    `is None` / typed-error check. Any other failure (pending state,
    transport blip, ...) is retried instead of being treated as proof of
    deletion - a false "not found" would hide the real leak this test
    exists to catch.
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            await rt.get_info(box_id)
        except Exception as exc:
            if "not found" in str(exc).lower():
                return True
            if time.monotonic() > deadline:
                raise
            await asyncio.sleep(1.0)
            continue
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(1.0)


@pytest.mark.asyncio
async def test_simplebox_auto_remove_deletes_on_exit(rt, image):
    """auto_remove=True must delete the box on exit, not just stop it."""
    box = boxlite.SimpleBox(image=image, runtime=rt, auto_remove=True)
    async with box:
        pass

    assert await _box_gone(rt, box.id), (
        f"box {box.id} is still present after SimpleBox exited with "
        "auto_remove=True; Box.__aexit__ only stops the VM, so SimpleBox "
        "itself must issue the delete"
    )


@pytest.mark.asyncio
async def test_simplebox_auto_remove_false_keeps_box(rt, image):
    """auto_remove=False must leave the box stopped, not deleted, on exit."""
    box = boxlite.SimpleBox(image=image, runtime=rt, auto_remove=False)
    async with box:
        pass
    try:
        info = await rt.get_info(box.id)
        assert info is not None, "box was deleted despite auto_remove=False"
    finally:
        # stop() (run by the `async with` above) leaves the box briefly
        # `pending` server-side; give that a moment to clear before the
        # cleanup remove() below, same as test_lifecycle_comprehensive.py's
        # stop -> sleep(1) -> next-operation pattern.
        await asyncio.sleep(1)
        await rt.remove(box.id, force=True)
