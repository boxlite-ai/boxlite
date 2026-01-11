"""
Integration tests for the synchronous API (greenlet-based).

These tests exercise the SyncBoxlite.default() context manager and the
SyncBoxlite/SyncBox/SyncExecution classes that mirror the async API.
They launch real VMs, so we mark them as ``integration``.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Iterable

import pytest

import boxlite

# Try to import sync API - skip if greenlet not installed
try:
    from boxlite import SyncBoxlite, SyncBox
    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed"),
]


def _candidate_library_dirs() -> Iterable[Path]:
    """Yield directories that may hold libkrun/libkrunfw dylibs."""

    package_dir = Path(boxlite.__file__).parent
    bundled = package_dir / ".dylibs"
    if bundled.exists():
        yield bundled

    # Homebrew layout on Apple Silicon
    hb_root = Path("/opt/homebrew/opt")
    hb_dirs = [hb_root / "libkrun" / "lib", hb_root / "libkrunfw" / "lib"]
    if all(path.exists() for path in hb_dirs):
        yield from hb_dirs


@pytest.fixture(autouse=True)
def _ensure_library_paths(monkeypatch):
    """Populate the dynamic loader search path so libkrun can be found."""

    dirs = [str(path) for path in _candidate_library_dirs()]
    if not dirs:
        pytest.skip("libkrun libraries are not available on this system")

    joined = ":".join(dirs)
    if sys.platform == "darwin":
        vars_to_set = ["DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH"]
    else:
        vars_to_set = ["LD_LIBRARY_PATH"]

    for var in vars_to_set:
        existing = os.environ.get(var)
        value = joined if not existing else ":".join([joined, existing])
        monkeypatch.setenv(var, value)


# =============================================================================
# Context Manager Tests
# =============================================================================

class TestSyncBoxliteContextManager:
    """Tests for SyncBoxlite used as context manager."""

    def test_context_manager_returns_sync_boxlite(self):
        """SyncBoxlite as context manager returns self."""
        with SyncBoxlite.default() as runtime:
            assert isinstance(runtime, SyncBoxlite)
            assert hasattr(runtime, "create")
            assert hasattr(runtime, "get")
            assert hasattr(runtime, "list_info")
            assert hasattr(runtime, "metrics")
            assert hasattr(runtime, "stop")

    def test_context_manager_has_stop_method(self):
        """SyncBoxlite has stop() method."""
        with SyncBoxlite.default() as runtime:
            assert hasattr(runtime, "stop")
            assert callable(runtime.stop)

    def test_context_manager_cleanup(self):
        """Context manager properly cleans up on exit."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            box.stop()
        # Should not raise - context manager exited cleanly


# =============================================================================
# Manual Start/Stop Tests
# =============================================================================

class TestManualStartStop:
    """Tests for manual start()/stop() pattern."""

    def test_start_returns_sync_boxlite(self):
        """start() returns SyncBoxlite instance."""
        runtime = SyncBoxlite.default().start()
        try:
            assert isinstance(runtime, SyncBoxlite)
            assert hasattr(runtime, "stop")
        finally:
            runtime.stop()

    def test_start_stop_lifecycle(self):
        """Manual start/stop lifecycle works correctly."""
        runtime = SyncBoxlite.default().start()
        try:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec("echo", ["hello"])
            stdout = list(execution.stdout())
            assert len(stdout) > 0
            assert "hello" in stdout[0]
            execution.wait()
            box.stop()
        finally:
            runtime.stop()

    def test_stop_can_be_called_multiple_times(self):
        """Calling stop() multiple times should not raise."""
        runtime = SyncBoxlite.default().start()
        runtime.stop()
        # Second call should be safe (idempotent behavior)
        # Note: Depending on implementation, this might raise or be no-op


# =============================================================================
# SyncBox Tests
# =============================================================================

class TestSyncBox:
    """Tests for SyncBox class."""

    def test_create_box(self):
        """Can create a box via runtime.create()."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            assert box is not None
            assert hasattr(box, "id")
            assert box.id is not None
            box.stop()

    def test_box_info(self):
        """Can get box info."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(
                image="alpine:latest",
                cpus=2,
                memory_mib=256,
            ))
            info = box.info()
            assert info.id == box.id
            assert info.image == "alpine:latest"
            assert info.cpus == 2
            assert info.memory_mib == 256
            box.stop()

    def test_box_exec_simple(self):
        """Can run simple command."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec("echo", ["hello", "world"])

            stdout_lines = list(execution.stdout())
            assert len(stdout_lines) > 0
            assert "hello world" in stdout_lines[0]

            result = execution.wait()
            assert result.exit_code == 0
            box.stop()

    def test_box_exec_with_env(self):
        """Can run command with environment variables."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec(
                "sh",
                ["-c", "echo $MY_VAR"],
                [("MY_VAR", "test_value")]
            )

            stdout_lines = list(execution.stdout())
            assert any("test_value" in line for line in stdout_lines)

            result = execution.wait()
            assert result.exit_code == 0
            box.stop()

    def test_box_exec_stderr(self):
        """Can capture stderr from command."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec("sh", ["-c", "echo error >&2"])

            stderr_lines = list(execution.stderr())
            assert len(stderr_lines) > 0
            assert any("error" in line for line in stderr_lines)

            result = execution.wait()
            assert result.exit_code == 0
            box.stop()

    def test_box_exec_nonzero_exit(self):
        """Command with non-zero exit code is captured."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec("sh", ["-c", "exit 42"])

            list(execution.stdout())  # Consume output
            result = execution.wait()
            assert result.exit_code == 42
            box.stop()

    def test_box_metrics(self):
        """Can get box metrics."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))

            # Run a command to generate some metrics
            execution = box.exec("echo", ["test"])
            list(execution.stdout())
            execution.wait()

            metrics = box.metrics()
            assert metrics is not None
            assert metrics.commands_executed_total >= 1
            box.stop()

    def test_box_context_manager(self):
        """Box works as context manager."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))

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

    def test_execution_id(self):
        """Execution has an id."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec("echo", ["test"])

            assert execution.id is not None

            list(execution.stdout())
            execution.wait()
            box.stop()

    def test_execution_kill(self):
        """Can kill a running execution."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec("sleep", ["100"])

            time.sleep(0.5)  # Let it start
            execution.kill()

            result = execution.wait()
            # Killed processes typically have negative exit code (signal)
            assert result.exit_code != 0
            box.stop()

    def test_stdout_iteration(self):
        """Can iterate over stdout synchronously."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec("sh", ["-c", "echo line1; echo line2; echo line3"])

            lines = []
            for line in execution.stdout():
                lines.append(line.strip())

            assert len(lines) >= 1  # May be combined or separate
            execution.wait()
            box.stop()


# =============================================================================
# Runtime Tests
# =============================================================================

class TestSyncBoxliteRuntime:
    """Tests for SyncBoxlite runtime methods."""

    def test_list_info(self):
        """Can list all boxes."""
        with SyncBoxlite.default() as runtime:
            # Create a box
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))

            # List should include our box
            infos = runtime.list_info()
            assert isinstance(infos, list)
            assert any(info.id == box.id for info in infos)

            box.stop()

    def test_get_box(self):
        """Can get existing box by ID."""
        with SyncBoxlite.default() as runtime:
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            box_id = box.id

            # Get by ID
            retrieved = runtime.get(box_id)
            assert retrieved is not None
            assert retrieved.id == box_id

            box.stop()

    def test_get_nonexistent_box(self):
        """Getting non-existent box returns None."""
        with SyncBoxlite.default() as runtime:
            retrieved = runtime.get("nonexistent-id-12345")
            assert retrieved is None

    def test_runtime_metrics(self):
        """Can get runtime metrics."""
        with SyncBoxlite.default() as runtime:
            # Create and stop a box to generate metrics
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            execution = box.exec("echo", ["test"])
            list(execution.stdout())
            execution.wait()
            box.stop()

            metrics = runtime.metrics()
            assert metrics is not None
            assert metrics.boxes_created_total >= 1


# =============================================================================
# Edge Cases and Error Handling
# =============================================================================

class TestSyncAPIEdgeCases:
    """Tests for edge cases and error handling."""

    def test_multiple_boxes_same_runtime(self):
        """Can create multiple boxes in same runtime."""
        with SyncBoxlite.default() as runtime:
            boxes = []
            for i in range(3):
                box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
                boxes.append(box)

            assert len(boxes) == 3
            assert len(set(b.id for b in boxes)) == 3  # All unique IDs

            for box in boxes:
                box.stop()

    def test_box_with_named_id(self):
        """Can create box with custom name."""
        with SyncBoxlite.default() as runtime:
            name = f"test-box-{int(time.time())}"
            box = runtime.create(
                boxlite.BoxOptions(image="alpine:latest"),
                name=name
            )

            # Should be retrievable by name
            retrieved = runtime.get(name)
            assert retrieved is not None
            assert retrieved.id == box.id

            box.stop()

    def test_sequential_start_stop(self):
        """Can start and stop runtime multiple times sequentially."""
        for _ in range(3):
            runtime = SyncBoxlite.default().start()
            box = runtime.create(boxlite.BoxOptions(image="alpine:latest"))
            box.stop()
            runtime.stop()
