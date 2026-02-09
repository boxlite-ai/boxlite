"""
Integration tests for the synchronous API (greenlet-based).

These tests exercise the SyncBoxlite/SyncBox/SyncExecution classes that mirror
the async API. They launch real VMs, so we mark them as ``integration``.
"""

from __future__ import annotations

import time

import pytest

import boxlite

# Try to import sync API - skip if greenlet not installed
try:
    from boxlite import SyncBoxlite

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed"),
]


# =============================================================================
# SyncBoxlite Tests
# =============================================================================


class TestSyncBoxliteRuntime:
    """Tests for SyncBoxlite runtime."""

    def test_runtime_has_expected_methods(self, shared_sync_runtime):
        """SyncBoxlite has expected methods."""
        assert hasattr(shared_sync_runtime, "create")
        assert hasattr(shared_sync_runtime, "get")
        assert hasattr(shared_sync_runtime, "list_info")
        assert hasattr(shared_sync_runtime, "metrics")
        assert hasattr(shared_sync_runtime, "stop")

    def test_runtime_is_sync_boxlite(self, shared_sync_runtime):
        """Runtime is SyncBoxlite instance."""
        assert isinstance(shared_sync_runtime, SyncBoxlite)


# =============================================================================
# SyncBox Tests
# =============================================================================


class TestSyncBox:
    """Tests for SyncBox class."""

    def test_create_box(self, shared_sync_runtime):
        """Can create a box via runtime.create()."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        assert box is not None
        assert hasattr(box, "id")
        assert box.id is not None
        box.stop()

    def test_box_info(self, shared_sync_runtime):
        """Can get box info."""
        box = shared_sync_runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                cpus=2,
                memory_mib=256,
            )
        )
        info = box.info()
        assert info.id == box.id
        assert info.image == "alpine:latest"
        assert info.cpus == 2
        assert info.memory_mib == 256
        box.stop()

    def test_box_exec_simple(self, shared_sync_runtime):
        """Can run simple command."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("echo", ["hello", "world"])

        stdout_lines = list(execution.stdout())
        assert len(stdout_lines) > 0
        assert "hello world" in stdout_lines[0]

        result = execution.wait()
        assert result.exit_code == 0
        box.stop()

    def test_box_exec_with_env(self, shared_sync_runtime):
        """Can run command with environment variables."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("sh", ["-c", "echo $MY_VAR"], [("MY_VAR", "test_value")])

        stdout_lines = list(execution.stdout())
        assert any("test_value" in line for line in stdout_lines)

        result = execution.wait()
        assert result.exit_code == 0
        box.stop()

    def test_box_exec_stderr(self, shared_sync_runtime):
        """Can capture stderr from command."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("sh", ["-c", "echo error >&2"])

        stderr_lines = list(execution.stderr())
        assert len(stderr_lines) > 0
        assert any("error" in line for line in stderr_lines)

        result = execution.wait()
        assert result.exit_code == 0
        box.stop()

    def test_box_exec_nonzero_exit(self, shared_sync_runtime):
        """Command with non-zero exit code is captured."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("sh", ["-c", "exit 42"])

        list(execution.stdout())  # Consume output
        result = execution.wait()
        assert result.exit_code == 42
        box.stop()

    def test_box_metrics(self, shared_sync_runtime):
        """Can get box metrics."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))

        # Run a command to generate some metrics
        execution = box.exec("echo", ["test"])
        list(execution.stdout())
        execution.wait()

        metrics = box.metrics()
        assert metrics is not None
        assert metrics.commands_executed_total >= 1
        box.stop()

    def test_box_context_manager(self, shared_sync_runtime):
        """Box works as context manager."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))

        with box:
            execution = box.exec("echo", ["context manager"])
            stdout_lines = list(execution.stdout())
            assert len(stdout_lines) > 0
            execution.wait()

        # Box should be stopped after exiting context


# =============================================================================
# SyncExecution Tests
# =============================================================================


class TestSyncExecution:
    """Tests for SyncExecution class."""

    def test_execution_id(self, shared_sync_runtime):
        """Execution has an id."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("echo", ["test"])

        assert execution.id is not None

        list(execution.stdout())
        execution.wait()
        box.stop()

    def test_execution_kill(self, shared_sync_runtime):
        """Can kill a running execution."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("sleep", ["100"])

        time.sleep(0.5)  # Let it start
        execution.kill()

        result = execution.wait()
        # Killed processes typically have negative exit code (signal)
        assert result.exit_code != 0
        box.stop()

    def test_stdout_iteration(self, shared_sync_runtime):
        """Can iterate over stdout synchronously."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("sh", ["-c", "echo line1; echo line2; echo line3"])

        lines = []
        for line in execution.stdout():
            lines.append(line.strip())

        assert len(lines) >= 1  # May be combined or separate
        execution.wait()
        box.stop()

    def test_resize_tty_on_tty_execution(self, shared_sync_runtime):
        """resize_tty succeeds on a TTY-enabled execution."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("sh", tty=True)

        # Should not raise
        execution.resize_tty(40, 120)

        execution.kill()
        execution.wait()
        box.stop()

    def test_resize_tty_on_non_tty_execution(self, shared_sync_runtime):
        """resize_tty on a non-TTY execution raises an error."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("echo", ["hello"])

        with pytest.raises(Exception):
            execution.resize_tty(40, 120)

        execution.wait()
        box.stop()

    def test_resize_tty_various_dimensions(self, shared_sync_runtime):
        """resize_tty accepts various terminal dimensions."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("sh", tty=True)

        # Small terminal
        execution.resize_tty(24, 80)
        # Large terminal
        execution.resize_tty(100, 300)
        # Minimum dimensions
        execution.resize_tty(1, 1)

        execution.kill()
        execution.wait()
        box.stop()

    def test_resize_tty_method_exists(self, shared_sync_runtime):
        """SyncExecution has resize_tty method."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("echo", ["test"])

        assert hasattr(execution, "resize_tty")
        assert callable(execution.resize_tty)

        list(execution.stdout())
        execution.wait()
        box.stop()


# =============================================================================
# Runtime Methods Tests
# =============================================================================


class TestSyncBoxliteRuntimeMethods:
    """Tests for SyncBoxlite runtime methods."""

    def test_list_info(self, shared_sync_runtime):
        """Can list all boxes."""
        # Create a box
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))

        # List should include our box
        infos = shared_sync_runtime.list_info()
        assert isinstance(infos, list)
        assert any(info.id == box.id for info in infos)

        box.stop()

    def test_get_box(self, shared_sync_runtime):
        """Can get existing box by ID."""
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        box_id = box.id

        # Get by ID
        retrieved = shared_sync_runtime.get(box_id)
        assert retrieved is not None
        assert retrieved.id == box_id

        box.stop()

    def test_get_nonexistent_box(self, shared_sync_runtime):
        """Getting non-existent box returns None."""
        retrieved = shared_sync_runtime.get("nonexistent-id-12345")
        assert retrieved is None

    def test_runtime_metrics(self, shared_sync_runtime):
        """Can get runtime metrics."""
        # Create and stop a box to generate metrics
        box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        execution = box.exec("echo", ["test"])
        list(execution.stdout())
        execution.wait()
        box.stop()

        metrics = shared_sync_runtime.metrics()
        assert metrics is not None
        assert metrics.boxes_created_total >= 1


# =============================================================================
# Edge Cases and Error Handling
# =============================================================================


class TestSyncAPIEdgeCases:
    """Tests for edge cases and error handling."""

    def test_multiple_boxes_same_runtime(self, shared_sync_runtime):
        """Can create multiple boxes in same runtime."""
        boxes = []
        for i in range(3):
            box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            boxes.append(box)

        assert len(boxes) == 3
        assert len(set(b.id for b in boxes)) == 3  # All unique IDs

        for box in boxes:
            box.stop()

    def test_box_with_named_id(self, shared_sync_runtime):
        """Can create box with custom name."""
        name = f"test-box-{int(time.time())}"
        box = shared_sync_runtime.create(
            boxlite.BoxOptions(image="alpine:latest"), name=name
        )

        # Should be retrievable by name
        retrieved = shared_sync_runtime.get(name)
        assert retrieved is not None
        assert retrieved.id == box.id

        box.stop()
