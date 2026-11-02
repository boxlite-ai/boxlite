"""Integration tests for the async SimpleBox convenience wrapper."""

from __future__ import annotations

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


async def test_simplebox_metrics(shared_runtime):
    """Async SimpleBox exposes box metrics like SyncSimpleBox."""
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await box.exec("echo", "test")
        metrics = await box.metrics()
        assert metrics is not None
        assert metrics.commands_executed_total >= 1


async def test_simplebox_info_is_awaitable(shared_runtime):
    """Async SimpleBox resolves box metadata through its native handle."""
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        info = await box.info()
        assert info.id == box.id


async def test_removed_box_context_cleanup_is_idempotent(shared_runtime):
    handle = await shared_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
    await shared_runtime.remove(handle.id, force=True)

    with pytest.raises(boxlite.NotFoundError):
        await handle.stop()

    await handle.__aexit__(None, None, None)


async def test_simplebox_cleanup_preserves_body_exception_after_removal(shared_runtime):
    with pytest.raises(ValueError, match="original body error"):
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            await shared_runtime.remove(box.id, force=True)
            raise ValueError("original body error")
