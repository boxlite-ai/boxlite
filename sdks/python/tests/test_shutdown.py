"""
Integration tests for runtime shutdown functionality.

These tests verify the shutdown() method on the Boxlite runtime.
"""

from __future__ import annotations

import boxlite
import pytest

pytestmark = pytest.mark.integration


class TestShutdown:
    """Test runtime shutdown functionality."""

    @pytest.mark.asyncio
    async def test_shutdown_default_timeout(self):
        """Shutdown with default 10 second timeout."""
        runtime = boxlite.Boxlite.default()
        await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        await runtime.shutdown()

    @pytest.mark.asyncio
    async def test_shutdown_custom_timeout(self):
        """Shutdown with custom timeout."""
        runtime = boxlite.Boxlite.default()
        await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        await runtime.shutdown(timeout=5)

    @pytest.mark.asyncio
    async def test_shutdown_idempotent(self):
        """Shutdown can be called multiple times safely."""
        runtime = boxlite.Boxlite.default()
        await runtime.shutdown()
        await runtime.shutdown()  # Should not fail

    @pytest.mark.asyncio
    async def test_shutdown_multiple_boxes(self):
        """Shutdown gracefully stops multiple boxes."""
        runtime = boxlite.Boxlite.default()

        # Create multiple boxes
        boxes = []
        for i in range(3):
            box = await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            boxes.append(box)

        # Verify boxes are running
        metrics = await runtime.metrics()
        assert metrics.num_running_boxes >= 3

        # Shutdown all
        await runtime.shutdown(timeout=10)

    @pytest.mark.asyncio
    async def test_operations_fail_after_shutdown(self):
        """Operations fail after runtime shutdown."""
        runtime = boxlite.Boxlite.default()
        await runtime.shutdown()

        with pytest.raises(RuntimeError):
            await runtime.create(boxlite.BoxOptions(image="alpine:latest"))


class TestShutdownSync:
    """Test runtime shutdown with sync API."""

    def test_shutdown_sync_default(self):
        """Shutdown via sync API with default timeout."""
        # Create a separate runtime for this test since shutdown is permanent
        with boxlite.SyncBoxlite.default() as runtime:
            runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            runtime.shutdown()

    def test_shutdown_sync_custom_timeout(self):
        """Shutdown via sync API with custom timeout."""
        with boxlite.SyncBoxlite.default() as runtime:
            runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            runtime.shutdown(timeout=5)

    def test_shutdown_sync_idempotent(self):
        """Sync shutdown can be called multiple times safely."""
        with boxlite.SyncBoxlite.default() as runtime:
            runtime.shutdown()
            runtime.shutdown()  # Should not fail


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
