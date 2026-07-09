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
