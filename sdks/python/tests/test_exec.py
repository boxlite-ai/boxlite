"""
Unit tests for ExecResult dataclass (no VM required).

Tests the ExecResult structure and behavior.
"""

import pytest
from dataclasses import is_dataclass

import boxlite
from boxlite.exec import ExecResult


class TestExecResultStructure:
    """Test ExecResult dataclass structure."""

    def test_is_dataclass(self):
        """Test that ExecResult is a dataclass."""
        assert is_dataclass(ExecResult)

    def test_has_required_fields(self):
        """Test that ExecResult has all required fields."""
        result = ExecResult(exit_code=0, stdout="output", stderr="error")
        assert hasattr(result, "exit_code")
        assert hasattr(result, "stdout")
        assert hasattr(result, "stderr")

    def test_field_types(self):
        """Test that ExecResult fields have correct types."""
        result = ExecResult(exit_code=0, stdout="out", stderr="err")
        assert isinstance(result.exit_code, int)
        assert isinstance(result.stdout, str)
        assert isinstance(result.stderr, str)


class TestExecResultCreation:
    """Test ExecResult creation."""

    def test_create_success_result(self):
        """Test creating a successful execution result."""
        result = ExecResult(exit_code=0, stdout="Hello, World!\n", stderr="")
        assert result.exit_code == 0
        assert result.stdout == "Hello, World!\n"
        assert result.stderr == ""

    def test_create_failure_result(self):
        """Test creating a failed execution result."""
        result = ExecResult(exit_code=1, stdout="", stderr="Command not found")
        assert result.exit_code == 1
        assert result.stdout == ""
        assert result.stderr == "Command not found"

    def test_create_mixed_output(self):
        """Test creating result with both stdout and stderr."""
        result = ExecResult(
            exit_code=0, stdout="Normal output\n", stderr="Warning: something\n"
        )
        assert result.exit_code == 0
        assert "Normal output" in result.stdout
        assert "Warning" in result.stderr

    def test_create_negative_exit_code(self):
        """Test creating result with negative exit code (signal)."""
        result = ExecResult(exit_code=-9, stdout="", stderr="Killed")
        assert result.exit_code == -9

    def test_create_multiline_output(self):
        """Test creating result with multiline output."""
        stdout = "line1\nline2\nline3\n"
        result = ExecResult(exit_code=0, stdout=stdout, stderr="")
        assert result.stdout.count("\n") == 3


class TestExecResultEquality:
    """Test ExecResult equality (dataclass auto-generated)."""

    def test_equal_results(self):
        """Test that equal results compare as equal."""
        result1 = ExecResult(exit_code=0, stdout="out", stderr="err")
        result2 = ExecResult(exit_code=0, stdout="out", stderr="err")
        assert result1 == result2

    def test_unequal_exit_code(self):
        """Test that different exit codes make results unequal."""
        result1 = ExecResult(exit_code=0, stdout="out", stderr="err")
        result2 = ExecResult(exit_code=1, stdout="out", stderr="err")
        assert result1 != result2

    def test_unequal_stdout(self):
        """Test that different stdout makes results unequal."""
        result1 = ExecResult(exit_code=0, stdout="out1", stderr="err")
        result2 = ExecResult(exit_code=0, stdout="out2", stderr="err")
        assert result1 != result2

    def test_unequal_stderr(self):
        """Test that different stderr makes results unequal."""
        result1 = ExecResult(exit_code=0, stdout="out", stderr="err1")
        result2 = ExecResult(exit_code=0, stdout="out", stderr="err2")
        assert result1 != result2


class TestExecResultRepresentation:
    """Test ExecResult string representation."""

    def test_repr(self):
        """Test that ExecResult has a useful repr."""
        result = ExecResult(exit_code=0, stdout="output", stderr="")
        repr_str = repr(result)
        assert "ExecResult" in repr_str
        assert "exit_code=0" in repr_str
        assert "stdout='output'" in repr_str


class TestExecResultUsage:
    """Test ExecResult usage patterns."""

    def test_check_success(self):
        """Test checking if execution was successful."""
        success = ExecResult(exit_code=0, stdout="ok", stderr="")
        failure = ExecResult(exit_code=1, stdout="", stderr="error")

        assert success.exit_code == 0
        assert failure.exit_code != 0

    def test_combine_output(self):
        """Test combining stdout and stderr."""
        result = ExecResult(
            exit_code=0, stdout="standard output\n", stderr="error output\n"
        )
        combined = result.stdout + result.stderr
        assert "standard output" in combined
        assert "error output" in combined

    def test_empty_result(self):
        """Test result with no output."""
        result = ExecResult(exit_code=0, stdout="", stderr="")
        assert result.stdout == ""
        assert result.stderr == ""

    def test_unicode_output(self):
        """Test result with unicode characters."""
        result = ExecResult(exit_code=0, stdout="Hello, 世界! 🎉\n", stderr="")
        assert "世界" in result.stdout
        assert "🎉" in result.stdout


class TestExecResultExports:
    """Test that ExecResult is properly exported."""

    def test_in_boxlite_module(self):
        """Test that ExecResult is exported from boxlite."""
        assert hasattr(boxlite, "ExecResult")
        assert boxlite.ExecResult is ExecResult

    def test_from_exec_module(self):
        """Test that ExecResult can be imported from exec module."""
        from boxlite.exec import ExecResult as ER

        assert ER is ExecResult


class TestExecutionAPIExports:
    """Test that Execution class exposes expected methods.

    These tests require the native Rust extension to be compiled
    (run ``make dev:python`` first).
    """

    @pytest.fixture(autouse=True)
    def _require_native(self):
        if not hasattr(boxlite, "Execution"):
            pytest.skip("native extension not compiled (run make dev:python)")

    def test_execution_in_module(self):
        """Test that Execution is exported from boxlite."""
        assert hasattr(boxlite, "Execution")

    def test_execution_has_resize_tty(self):
        """Test that Execution class has resize_tty method."""
        assert hasattr(boxlite.Execution, "resize_tty")

    def test_execution_has_kill(self):
        """Test that Execution class has kill method."""
        assert hasattr(boxlite.Execution, "kill")

    def test_execution_has_wait(self):
        """Test that Execution class has wait method."""
        assert hasattr(boxlite.Execution, "wait")

    def test_execution_has_stdin(self):
        """Test that Execution class has stdin method."""
        assert hasattr(boxlite.Execution, "stdin")

    def test_execution_has_stdout(self):
        """Test that Execution class has stdout method."""
        assert hasattr(boxlite.Execution, "stdout")

    def test_execution_has_stderr(self):
        """Test that Execution class has stderr method."""
        assert hasattr(boxlite.Execution, "stderr")


class TestSyncExecutionAPIExports:
    """Test that SyncExecution class exposes expected methods."""

    def test_sync_execution_has_resize_tty(self):
        """Test that SyncExecution class has resize_tty method."""
        try:
            from boxlite.sync_api._execution import SyncExecution

            assert hasattr(SyncExecution, "resize_tty")
            assert callable(getattr(SyncExecution, "resize_tty"))
        except ImportError:
            pytest.skip("sync API not available")

    def test_sync_execution_has_kill(self):
        """Test that SyncExecution class has kill method."""
        try:
            from boxlite.sync_api._execution import SyncExecution

            assert hasattr(SyncExecution, "kill")
        except ImportError:
            pytest.skip("sync API not available")

    def test_sync_execution_has_wait(self):
        """Test that SyncExecution class has wait method."""
        try:
            from boxlite.sync_api._execution import SyncExecution

            assert hasattr(SyncExecution, "wait")
        except ImportError:
            pytest.skip("sync API not available")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
