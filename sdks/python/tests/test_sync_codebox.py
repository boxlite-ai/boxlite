"""
Integration tests for SyncCodeBox convenience wrapper.

Tests the synchronous CodeBox API using greenlet fiber switching.
These tests require a working VM/libkrun setup.
"""

from __future__ import annotations

import pytest

# Try to import sync API - skip if greenlet not installed
try:
    from boxlite import SyncCodeBox

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed"),
]


class TestSyncCodeBox:
    """Tests for SyncCodeBox convenience wrapper."""

    def test_context_manager(self, shared_sync_runtime):
        """SyncCodeBox works as context manager."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            assert box is not None
            assert box.id is not None

    def test_default_image(self, shared_sync_runtime):
        """Uses Python image by default."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            info = box.info()
            assert "python" in info.image.lower()

    def test_run_simple(self, shared_sync_runtime):
        """Can run simple Python code."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            result = box.run("print('Hello, World!')")
            assert "Hello, World!" in result

    def test_run_arithmetic(self, shared_sync_runtime):
        """Can run arithmetic operations."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            result = box.run("print(2 + 2)")
            assert "4" in result

    def test_run_multiline(self, shared_sync_runtime):
        """Can run multiline code."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            code = """
x = 10
y = 20
print(x + y)
"""
            result = box.run(code)
            assert "30" in result

    def test_run_with_imports(self, shared_sync_runtime):
        """Can run code with stdlib imports."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            code = """
import math
print(round(math.pi, 2))
"""
            result = box.run(code)
            assert "3.14" in result

    def test_run_exception(self, shared_sync_runtime):
        """Exceptions go to stderr, not run() output."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            result = box.exec(
                "/usr/local/bin/python", "-c", "raise ValueError('test error')"
            )
            assert "ValueError" in result.stderr or "test error" in result.stderr

    @pytest.mark.slow
    def test_install_package(self, shared_sync_runtime):
        """Can install a package."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            result = box.install_package("six")
            assert (
                "Successfully installed" in result
                or "already satisfied" in result.lower()
            )

    @pytest.mark.slow
    def test_install_and_use(self, shared_sync_runtime):
        """Can install and use a package."""
        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            box.install_package("six")
            result = box.run("import six; print(six.PY3)")
            assert "True" in result

    def test_run_script(self, shared_sync_runtime, tmp_path):
        """Can run a script file."""
        script = tmp_path / "test_script.py"
        script.write_text("print('Hello from script!')\n")

        with SyncCodeBox(runtime=shared_sync_runtime) as box:
            result = box.run_script(str(script))
            assert "Hello from script!" in result
