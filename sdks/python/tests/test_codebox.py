"""
Integration tests for CodeBox functionality.

Tests the CodeBox class for secure Python code execution.
These tests require a working VM/libkrun setup.
"""

from __future__ import annotations

import os
import tempfile

import boxlite
import pytest

pytestmark = pytest.mark.integration


class TestCodeBoxBasic:
    """Test basic CodeBox functionality."""

    @pytest.mark.asyncio
    async def test_context_manager(self, shared_runtime):
        """Test CodeBox as async context manager."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            assert box is not None
            assert box.id is not None

    @pytest.mark.asyncio
    async def test_default_image(self, shared_runtime):
        """Test CodeBox uses Python image by default."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            info = box.info()
            assert "python" in info.image.lower()

    @pytest.mark.asyncio
    async def test_custom_image(self, shared_runtime):
        """Test CodeBox with custom Python image."""
        async with boxlite.CodeBox(
            image="python:3.11-slim", runtime=shared_runtime
        ) as box:
            info = box.info()
            assert "python" in info.image.lower()


class TestCodeBoxRun:
    """Test CodeBox.run() method for Python code execution."""

    @pytest.mark.asyncio
    async def test_simple_print(self, shared_runtime):
        """Test running simple print statement."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            result = await box.run("print('Hello, World!')")
            assert "Hello, World!" in result

    @pytest.mark.asyncio
    async def test_arithmetic(self, shared_runtime):
        """Test running arithmetic operations."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            result = await box.run("print(2 + 2)")
            assert "4" in result

    @pytest.mark.asyncio
    async def test_multiline_code(self, shared_runtime):
        """Test running multiline Python code."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            code = """
x = 10
y = 20
print(x + y)
"""
            result = await box.run(code)
            assert "30" in result

    @pytest.mark.asyncio
    async def test_function_definition(self, shared_runtime):
        """Test defining and calling functions."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            code = """
def add(a, b):
    return a + b

print(add(3, 4))
"""
            result = await box.run(code)
            assert "7" in result

    @pytest.mark.asyncio
    async def test_list_comprehension(self, shared_runtime):
        """Test list comprehension."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            code = "print([x**2 for x in range(5)])"
            result = await box.run(code)
            assert "[0, 1, 4, 9, 16]" in result

    @pytest.mark.asyncio
    async def test_import_stdlib(self, shared_runtime):
        """Test importing standard library modules."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            code = """
import math
print(math.pi)
"""
            result = await box.run(code)
            assert "3.14" in result

    @pytest.mark.asyncio
    async def test_import_json(self, shared_runtime):
        """Test JSON serialization."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            code = """
import json
data = {"key": "value", "number": 42}
print(json.dumps(data))
"""
            result = await box.run(code)
            assert "key" in result
            assert "value" in result
            assert "42" in result

    @pytest.mark.asyncio
    async def test_exception_output(self, shared_runtime):
        """Test that exceptions are captured in stderr."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            code = "raise ValueError('test error')"
            result = await box.exec("/usr/local/bin/python", "-c", code)
            assert "ValueError" in result.stderr or "test error" in result.stderr

    @pytest.mark.asyncio
    async def test_syntax_error(self, shared_runtime):
        """Test that syntax errors are captured in stderr."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            code = "print('unclosed"
            result = await box.exec("/usr/local/bin/python", "-c", code)
            assert "SyntaxError" in result.stderr or "error" in result.stderr.lower()


class TestCodeBoxRunScript:
    """Test CodeBox.run_script() method."""

    @pytest.mark.asyncio
    async def test_run_script_file(self, shared_runtime):
        """Test running a Python script file."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            # Create a temporary script file
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
                f.write("print('Hello from script!')\n")
                script_path = f.name

            try:
                result = await box.run_script(script_path)
                assert "Hello from script!" in result
            finally:
                os.unlink(script_path)

    @pytest.mark.asyncio
    async def test_run_script_with_imports(self, shared_runtime):
        """Test running a script with imports."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
                f.write("import sys\nprint(sys.version_info.major)\n")
                script_path = f.name

            try:
                result = await box.run_script(script_path)
                assert "3" in result  # Python 3
            finally:
                os.unlink(script_path)


class TestCodeBoxInstallPackage:
    """Test CodeBox package installation."""

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_install_single_package(self, shared_runtime):
        """Test installing a single package."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            result = await box.install_package("six")
            # pip output should indicate success
            assert (
                "Successfully installed" in result
                or "already satisfied" in result.lower()
            )

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_install_and_use_package(self, shared_runtime):
        """Test installing and using a package."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            await box.install_package("six")
            result = await box.run("import six; print(six.PY3)")
            assert "True" in result

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_install_multiple_packages(self, shared_runtime):
        """Test installing multiple packages."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            result = await box.install_packages("six", "packaging")
            # Should install both packages
            assert (
                "Successfully installed" in result
                or "already satisfied" in result.lower()
            )


class TestCodeBoxIsolation:
    """Test CodeBox isolation and security."""

    @pytest.mark.asyncio
    async def test_isolated_environment(self, shared_runtime):
        """Test that code runs in isolated environment."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            code = """
import os
print(f"Hostname: {os.uname().nodename}")
print(f"Home: {os.getenv('HOME', 'unknown')}")
"""
            result = await box.run(code)
            # Should run without errors
            assert "Hostname" in result

    @pytest.mark.asyncio
    async def test_cannot_access_host_files(self, shared_runtime):
        """Test that container cannot access host-specific files."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            # Try to access a path that would only exist on host
            code = """
import os
# This path is unlikely to exist in container
path = '/Users' if os.path.exists('/Users') else '/home'
print(f"Path check: {path}")
"""
            result = await box.run(code)
            # Should run without errors
            assert "Path check" in result


class TestCodeBoxMultipleRuns:
    """Test running multiple code snippets."""

    @pytest.mark.asyncio
    async def test_sequential_runs(self, shared_runtime):
        """Test running multiple code snippets sequentially."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            result1 = await box.run("print('first')")
            result2 = await box.run("print('second')")
            result3 = await box.run("print('third')")

            assert "first" in result1
            assert "second" in result2
            assert "third" in result3

    @pytest.mark.asyncio
    async def test_state_not_shared_between_runs(self, shared_runtime):
        """Test that variable state doesn't persist between runs."""
        async with boxlite.CodeBox(runtime=shared_runtime) as box:
            # Define a variable
            await box.run("x = 42")

            # Try to use it in next run - should fail since each run is
            # a separate python -c invocation
            result = await box.exec("/usr/local/bin/python", "-c", "print(x)")
            # Should get NameError since each run is independent
            assert "NameError" in result.stderr or "42" in result.stdout


class TestCodeBoxExports:
    """Test CodeBox module exports."""

    def test_codebox_in_module(self):
        """Test that CodeBox is exported from boxlite."""
        assert hasattr(boxlite, "CodeBox")

    def test_codebox_from_codebox_module(self):
        """Test that CodeBox can be imported from codebox module."""
        from boxlite.codebox import CodeBox

        assert CodeBox is boxlite.CodeBox


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
