"""
Integration tests for Execution.resize_tty() (sync API).

Tests the resize_tty method on TTY and non-TTY executions.
These tests require a working VM/libkrun setup.
"""

from __future__ import annotations

import boxlite
import pytest

pytestmark = pytest.mark.integration


class TestResizeTtySync:
    """Test resize_tty on sync Execution objects via SyncBox."""

    def test_resize_tty_on_tty_execution(self, shared_sync_runtime):
        """resize_tty succeeds on a TTY-enabled execution."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = box.exec("sh", tty=True)
            execution.resize_tty(40, 120)
            execution.kill()
            execution.wait()
        finally:
            box.stop()

    def test_resize_tty_on_non_tty_execution(self, shared_sync_runtime):
        """resize_tty on a non-TTY execution raises an error."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = box.exec("echo", ["hello"])
            with pytest.raises(Exception):
                execution.resize_tty(40, 120)
            execution.wait()
        finally:
            box.stop()

    def test_resize_tty_various_dimensions(self, shared_sync_runtime):
        """resize_tty accepts various terminal dimensions."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = box.exec("sh", tty=True)
            execution.resize_tty(24, 80)
            execution.resize_tty(100, 300)
            execution.resize_tty(1, 1)
            execution.kill()
            execution.wait()
        finally:
            box.stop()

    def test_resize_tty_after_process_output(self, shared_sync_runtime):
        """resize_tty works after the process has produced output."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = box.exec("sh", tty=True)
            stdin = execution.stdin()
            stdin.send_input(b"echo hello\n")
            execution.resize_tty(50, 160)
            execution.kill()
            execution.wait()
        finally:
            box.stop()

    def test_resize_tty_multiple_times(self, shared_sync_runtime):
        """resize_tty can be called multiple times on the same execution."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        try:
            execution = box.exec("sh", tty=True)
            for rows, cols in [(24, 80), (40, 120), (50, 200), (30, 100)]:
                execution.resize_tty(rows, cols)
            execution.kill()
            execution.wait()
        finally:
            box.stop()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
