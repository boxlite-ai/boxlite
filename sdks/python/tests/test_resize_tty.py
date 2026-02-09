"""
Integration tests for Execution.resize_tty() (async API).

Tests the resize_tty method on TTY and non-TTY executions.
These tests require a working VM/libkrun setup.
"""

from __future__ import annotations

import pytest

import boxlite

pytestmark = pytest.mark.integration


class TestResizeTtyAsync:
    """Test resize_tty on async Execution objects."""

    @pytest.mark.asyncio
    async def test_resize_tty_on_tty_execution(self, shared_runtime):
        """resize_tty succeeds on a TTY-enabled execution."""
        box = await shared_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = await box.exec("sh", tty=True)

            # Should not raise
            await execution.resize_tty(40, 120)

            await execution.kill()
            await execution.wait()
        finally:
            await box.stop()

    @pytest.mark.asyncio
    async def test_resize_tty_on_non_tty_execution(self, shared_runtime):
        """resize_tty on a non-TTY execution raises an error."""
        box = await shared_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = await box.exec("echo", ["hello"])

            with pytest.raises(Exception):
                await execution.resize_tty(40, 120)

            await execution.wait()
        finally:
            await box.stop()

    @pytest.mark.asyncio
    async def test_resize_tty_various_dimensions(self, shared_runtime):
        """resize_tty accepts various terminal dimensions."""
        box = await shared_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = await box.exec("sh", tty=True)

            # Standard terminal
            await execution.resize_tty(24, 80)
            # Large terminal
            await execution.resize_tty(100, 300)
            # Small terminal
            await execution.resize_tty(1, 1)

            await execution.kill()
            await execution.wait()
        finally:
            await box.stop()

    @pytest.mark.asyncio
    async def test_resize_tty_after_process_output(self, shared_runtime):
        """resize_tty works after the process has produced output."""
        box = await shared_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = await box.exec("sh", tty=True)

            # Send a command that produces output
            stdin = execution.stdin()
            await stdin.send_input(b"echo hello\n")

            # Resize should still work
            await execution.resize_tty(50, 160)

            await execution.kill()
            await execution.wait()
        finally:
            await box.stop()

    @pytest.mark.asyncio
    async def test_resize_tty_multiple_times(self, shared_runtime):
        """resize_tty can be called multiple times on the same execution."""
        box = await shared_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = await box.exec("sh", tty=True)

            for rows, cols in [(24, 80), (40, 120), (50, 200), (30, 100)]:
                await execution.resize_tty(rows, cols)

            await execution.kill()
            await execution.wait()
        finally:
            await box.stop()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
