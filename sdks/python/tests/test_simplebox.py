"""
Integration tests for SimpleBox functionality.

Tests the SimpleBox class which provides the foundation for specialized containers.
These tests require a working VM/libkrun setup.
"""

from __future__ import annotations

import boxlite
import pytest

pytestmark = pytest.mark.integration


class TestSimpleBoxBasic:
    """Test basic SimpleBox functionality."""

    @pytest.mark.asyncio
    async def test_context_manager(self, shared_runtime):
        """Test SimpleBox as async context manager."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            assert box is not None
            assert box.id is not None

    @pytest.mark.asyncio
    async def test_box_id_property(self, shared_runtime):
        """Test that SimpleBox has an id property."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            assert isinstance(box.id, str)
            assert len(box.id) == 26  # ULID format

    @pytest.mark.asyncio
    async def test_box_info(self, shared_runtime):
        """Test SimpleBox.info() method."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            info = box.info()
            assert info is not None
            assert info.id == box.id
            # info.state is a BoxStateInfo object with status, pid, running fields
            assert info.state.status in {"configured", "running"}


class TestSimpleBoxExec:
    """Test SimpleBox command execution."""

    @pytest.mark.asyncio
    async def test_basic_exec(self, shared_runtime):
        """Test basic command execution."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("echo", "hello")
            assert result.exit_code == 0
            assert "hello" in result.stdout

    @pytest.mark.asyncio
    async def test_exec_with_args(self, shared_runtime):
        """Test command execution with multiple arguments."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("ls", "-la", "/")
            assert result.exit_code == 0
            assert "bin" in result.stdout

    @pytest.mark.asyncio
    async def test_exec_stdout(self, shared_runtime):
        """Test that stdout is captured correctly."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("echo", "stdout test")
            assert "stdout test" in result.stdout
            assert result.stderr == "" or "stdout test" not in result.stderr

    @pytest.mark.asyncio
    async def test_exec_stderr(self, shared_runtime):
        """Test that stderr is captured correctly."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("sh", "-c", "echo error >&2")
            assert "error" in result.stderr

    @pytest.mark.asyncio
    async def test_exec_mixed_output(self, shared_runtime):
        """Test command with both stdout and stderr."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("sh", "-c", "echo stdout && echo stderr >&2")
            assert "stdout" in result.stdout
            assert "stderr" in result.stderr

    @pytest.mark.asyncio
    async def test_exec_exit_code_success(self, shared_runtime):
        """Test successful command exit code."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("true")
            assert result.exit_code == 0

    @pytest.mark.asyncio
    async def test_exec_exit_code_failure(self, shared_runtime):
        """Test failed command exit code."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("false")
            assert result.exit_code != 0

    @pytest.mark.asyncio
    async def test_exec_nonzero_exit(self, shared_runtime):
        """Test command with specific non-zero exit code."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("sh", "-c", "exit 42")
            assert result.exit_code == 42


class TestSimpleBoxEnvironment:
    """Test SimpleBox environment variable handling."""

    @pytest.mark.asyncio
    async def test_exec_with_env(self, shared_runtime):
        """Test command execution with environment variables."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("env", env={"FOO": "bar"})
            assert result.exit_code == 0
            assert "FOO=bar" in result.stdout

    @pytest.mark.asyncio
    async def test_exec_with_multiple_env(self, shared_runtime):
        """Test command with multiple environment variables."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("env", env={"VAR1": "value1", "VAR2": "value2"})
            assert "VAR1=value1" in result.stdout
            assert "VAR2=value2" in result.stdout

    @pytest.mark.asyncio
    async def test_box_level_env(self, shared_runtime):
        """Test box-level environment variables."""
        async with boxlite.SimpleBox(
            image="alpine:latest",
            env=[("BOX_VAR", "box_value")],
            runtime=shared_runtime,
        ) as box:
            result = await box.exec("env")
            assert "BOX_VAR=box_value" in result.stdout


class TestSimpleBoxWorkingDirectory:
    """Test SimpleBox working directory handling."""

    @pytest.mark.asyncio
    async def test_default_working_dir(self, shared_runtime):
        """Test default working directory."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result = await box.exec("pwd")
            assert result.exit_code == 0
            # Default is usually / or /root
            assert result.stdout.strip() in ["/", "/root"]

    @pytest.mark.asyncio
    async def test_custom_working_dir(self, shared_runtime):
        """Test custom working directory."""
        async with boxlite.SimpleBox(
            image="alpine:latest", working_dir="/tmp", runtime=shared_runtime
        ) as box:
            result = await box.exec("pwd")
            assert result.exit_code == 0
            assert result.stdout.strip() == "/tmp"


class TestSimpleBoxMultipleCommands:
    """Test running multiple commands in same container."""

    @pytest.mark.asyncio
    async def test_sequential_commands(self, shared_runtime):
        """Test running multiple commands sequentially."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            result1 = await box.exec("echo", "first")
            result2 = await box.exec("echo", "second")
            result3 = await box.exec("echo", "third")

            assert "first" in result1.stdout
            assert "second" in result2.stdout
            assert "third" in result3.stdout

    @pytest.mark.asyncio
    async def test_state_persists_between_commands(self, shared_runtime):
        """Test that filesystem state persists between commands."""
        async with boxlite.SimpleBox(
            image="alpine:latest", runtime=shared_runtime
        ) as box:
            # Create a file
            await box.exec("sh", "-c", "echo 'test content' > /tmp/testfile")

            # Read the file
            result = await box.exec("cat", "/tmp/testfile")
            assert "test content" in result.stdout


class TestSimpleBoxResourceLimits:
    """Test SimpleBox resource configuration."""

    @pytest.mark.asyncio
    async def test_custom_memory(self, shared_runtime):
        """Test box with custom memory limit."""
        async with boxlite.SimpleBox(
            image="alpine:latest", memory_mib=256, runtime=shared_runtime
        ) as box:
            info = box.info()
            assert info.memory_mib == 256

    @pytest.mark.asyncio
    async def test_custom_cpus(self, shared_runtime):
        """Test box with custom CPU count."""
        async with boxlite.SimpleBox(
            image="alpine:latest", cpus=2, runtime=shared_runtime
        ) as box:
            info = box.info()
            assert info.cpus == 2


class TestSimpleBoxExports:
    """Test SimpleBox module exports."""

    def test_simplebox_in_module(self):
        """Test that SimpleBox is exported from boxlite."""
        assert hasattr(boxlite, "SimpleBox")

    def test_simplebox_from_simplebox_module(self):
        """Test that SimpleBox can be imported from simplebox module."""
        from boxlite.simplebox import SimpleBox

        assert SimpleBox is boxlite.SimpleBox


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
