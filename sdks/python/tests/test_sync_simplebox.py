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


class TestSyncSimpleBoxConcurrentStreams:
    """Test that stdout and stderr are read concurrently in sync API.

    Sequential reads deadlock when a process writes enough to both streams:
    the kernel pipe buffer (~64KB) fills on the unread stream, blocking the
    process, which prevents the read stream from reaching EOF.
    """

    def test_concurrent_stdout_stderr_heavy(self, shared_sync_runtime):
        """Concurrent reads prevent deadlock with heavy interleaved output."""
        import signal

        # Write ALL stderr first, then ALL stdout. With sequential reads (stdout
        # first), the SDK would wait on an empty stdout channel while ~250KB of
        # stderr accumulates in an unbounded buffer. Concurrent reads consume
        # stderr as it arrives, avoiding unbounded memory growth.
        cmd = (
            "i=0; while [ $i -lt 5000 ]; do "
            'echo "stderr line $i padding to increase size" >&2; '
            "i=$((i+1)); done; "
            "i=0; while [ $i -lt 5000 ]; do "
            'echo "stdout line $i padding to increase size"; '
            "i=$((i+1)); done"
        )

        # Use SIGALRM as a timeout mechanism for the sync call.
        # A deadlock would hang forever; 60s is generous but safe.
        def timeout_handler(signum, frame):
            raise TimeoutError(
                "Deadlock detected: concurrent stream reading likely broken"
            )

        old_handler = signal.signal(signal.SIGALRM, timeout_handler)
        signal.alarm(60)
        try:
            with SyncSimpleBox(
                image="alpine:latest", runtime=shared_sync_runtime
            ) as box:
                result = box.exec("sh", "-c", cmd)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)

        assert result.exit_code == 0
        assert "stdout line 0" in result.stdout
        assert "stderr line 0" in result.stderr
        assert "stdout line 4999" in result.stdout
        assert "stderr line 4999" in result.stderr
        # Verify we got all lines (stderr may include runtime warnings)
        assert result.stdout.count("\n") == 5000
        assert result.stderr.count("\n") >= 5000


class TestSyncSimpleBoxReuseExisting:
    """Tests for SyncSimpleBox reuse_existing flag."""

    def test_reuse_existing_creates_new_box(self, shared_sync_runtime):
        """With reuse_existing=True and a unique name, a new box is created."""
        with SyncSimpleBox(
            image="alpine:latest",
            name="sync-reuse-new-test",
            reuse_existing=True,
            runtime=shared_sync_runtime,
        ) as box:
            assert box.created is True
            assert box.id is not None

    def test_reuse_existing_reuses_box(self, shared_sync_runtime):
        """With reuse_existing=True and an existing name, the box is reused."""
        name = "sync-reuse-existing-test"
        with SyncSimpleBox(
            image="alpine:latest",
            name=name,
            reuse_existing=True,
            runtime=shared_sync_runtime,
        ) as box1:
            box1_id = box1.id
            assert box1.created is True

            with SyncSimpleBox(
                image="alpine:latest",
                name=name,
                reuse_existing=True,
                runtime=shared_sync_runtime,
            ) as box2:
                assert box2.created is False
                assert box2.id == box1_id

    def test_default_fails_on_duplicate_name(self, shared_sync_runtime):
        """Without reuse_existing, duplicate names raise an error."""
        import pytest

        name = "sync-no-reuse-test"
        with SyncSimpleBox(
            image="alpine:latest",
            name=name,
            runtime=shared_sync_runtime,
        ) as box1:
            assert box1.created is True

            with pytest.raises(Exception):
                with SyncSimpleBox(
                    image="alpine:latest",
                    name=name,
                    runtime=shared_sync_runtime,
                ) as _box2:
                    pass
