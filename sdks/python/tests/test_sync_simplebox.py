"""
Integration tests for SyncSimpleBox convenience wrapper.

Tests the synchronous SimpleBox API using greenlet fiber switching.
These tests require a working VM/libkrun setup.
"""

from __future__ import annotations

import pytest

# Try to import sync API - skip if greenlet not installed
try:
    from boxlite import SyncSimpleBox

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed"),
]


class TestSyncSimpleBox:
    """Tests for SyncSimpleBox convenience wrapper."""

    def test_context_manager(self, shared_sync_runtime):
        """SyncSimpleBox works as context manager."""
        with SyncSimpleBox(image="alpine:latest", runtime=shared_sync_runtime) as box:
            assert box is not None
            assert box.id is not None

    def test_exec_basic(self, shared_sync_runtime):
        """Can run basic command."""
        with SyncSimpleBox(image="alpine:latest", runtime=shared_sync_runtime) as box:
            result = box.exec("echo", "hello")
            assert result.exit_code == 0
            assert "hello" in result.stdout

    def test_exec_with_args(self, shared_sync_runtime):
        """Can run command with multiple arguments."""
        with SyncSimpleBox(image="alpine:latest", runtime=shared_sync_runtime) as box:
            result = box.exec("ls", "-la", "/")
            assert result.exit_code == 0
            assert "bin" in result.stdout

    def test_exec_with_env(self, shared_sync_runtime):
        """Can run command with environment variables."""
        with SyncSimpleBox(image="alpine:latest", runtime=shared_sync_runtime) as box:
            result = box.exec("env", env={"FOO": "bar"})
            assert "FOO=bar" in result.stdout

    def test_exec_stdout_stderr(self, shared_sync_runtime):
        """Captures both stdout and stderr."""
        with SyncSimpleBox(image="alpine:latest", runtime=shared_sync_runtime) as box:
            result = box.exec("sh", "-c", "echo stdout && echo stderr >&2")
            assert "stdout" in result.stdout
            assert "stderr" in result.stderr

    def test_exec_exit_code(self, shared_sync_runtime):
        """Captures non-zero exit codes."""
        with SyncSimpleBox(image="alpine:latest", runtime=shared_sync_runtime) as box:
            result = box.exec("sh", "-c", "exit 42")
            assert result.exit_code == 42

    def test_info(self, shared_sync_runtime):
        """Can get box info."""
        with SyncSimpleBox(
            image="alpine:latest", cpus=2, runtime=shared_sync_runtime
        ) as box:
            info = box.info()
            assert info.id == box.id
            assert info.cpus == 2

    def test_metrics(self, shared_sync_runtime):
        """Can get box metrics."""
        with SyncSimpleBox(image="alpine:latest", runtime=shared_sync_runtime) as box:
            box.exec("echo", "test")
            metrics = box.metrics()
            assert metrics is not None
            assert metrics.commands_executed_total >= 1

    def test_custom_working_dir(self, shared_sync_runtime):
        """Can set custom working directory."""
        with SyncSimpleBox(
            image="alpine:latest", working_dir="/tmp", runtime=shared_sync_runtime
        ) as box:
            result = box.exec("pwd")
            assert result.stdout.strip() == "/tmp"

    def test_box_level_env(self, shared_sync_runtime):
        """Can set box-level environment variables."""
        with SyncSimpleBox(
            image="alpine:latest",
            env=[("MY_VAR", "my_value")],
            runtime=shared_sync_runtime,
        ) as box:
            result = box.exec("env")
            assert "MY_VAR=my_value" in result.stdout
