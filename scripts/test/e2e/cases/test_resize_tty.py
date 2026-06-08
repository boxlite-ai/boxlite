"""E2E port of `sdks/python/tests/test_resize_tty.py`.

Verifies that Execution.resize_tty(rows, cols) succeeds on a TTY-enabled
execution and is appropriately rejected on a non-TTY one. In REST mode
the resize travels SDK → API → runner as a WS control message; this
test catches regressions in that message wiring.
"""
from __future__ import annotations

import asyncio

import boxlite
import pytest

from conftest import drain


@pytest.mark.asyncio
async def test_resize_tty_on_tty_execution(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec("sh", [], None, tty=True)
        resize = getattr(ex, "resize_tty", None)
        if resize is None:
            pytest.skip("resize_tty not exposed in this SDK build")
        # 40 rows × 120 cols is a standard non-default size, easy to assert
        # round-trip
        result = resize(40, 120)
        if hasattr(result, "__await__"):
            await result
        # Tear down the exec cleanly
        if hasattr(ex, "kill"):
            kill_res = ex.kill()
            if hasattr(kill_res, "__await__"):
                await kill_res
        await asyncio.wait_for(ex.wait(), timeout=15)
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_resize_tty_on_non_tty_execution_raises(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec("echo", ["hello"], None)
        resize = getattr(ex, "resize_tty", None)
        if resize is None:
            pytest.skip("resize_tty not exposed in this SDK build")
        with pytest.raises(Exception):
            result = resize(40, 120)
            if hasattr(result, "__await__"):
                await result
        await drain(ex)
        await asyncio.wait_for(ex.wait(), timeout=15)
    finally:
        await rt.remove(box.id, force=True)
