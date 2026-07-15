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


async def test_simplebox_command_not_found_raises_exec_error(shared_runtime):
    """Direct command start failures raise ExecError, not bare RuntimeError."""
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        with pytest.raises(boxlite.ExecError) as exc:
            await box.exec("definitely-not-a-boxlite-command-xyz")
        assert exc.value.exit_code == 127
        assert "not found" in exc.value.stderr.lower()


async def test_simplebox_unexecutable_command_raises_exit_code_126(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await box.exec(
            "sh", "-c", "printf '#!/bin/sh\\n' > /tmp/noexec && chmod 644 /tmp/noexec"
        )
        with pytest.raises(boxlite.ExecError) as exc:
            await box.exec("/tmp/noexec")
        assert exc.value.exit_code == 126
        assert "permission denied" in exc.value.stderr.lower()
