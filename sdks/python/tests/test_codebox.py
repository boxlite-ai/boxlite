"""Unit tests for the CodeBox convenience wrappers.

A stand-in replaces the native box, so these run without the Rust
extension and check what ``run()`` hands to the native exec call.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from boxlite.codebox import CodeBox
from boxlite.sync_api._codebox import SyncCodeBox


class _Lines:
    """Async iterator over a fixed list of output lines."""

    def __init__(self, lines):
        self._lines = iter(lines)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._lines)
        except StopIteration:
            raise StopAsyncIteration from None


def _native_box():
    # A run cut off by its deadline: some output, then death by SIGKILL.
    execution = SimpleNamespace(
        stdout=lambda: _Lines(["partial\n"]),
        stderr=lambda: _Lines([]),
        wait=AsyncMock(return_value=SimpleNamespace(exit_code=137, error_message=None)),
    )
    return SimpleNamespace(exec=AsyncMock(return_value=execution))


@pytest.mark.asyncio
async def test_codebox_run_forwards_timeout_to_native_exec():
    native = _native_box()
    box = CodeBox.__new__(CodeBox)
    box._started = True
    box._box = native

    assert await box.run("while True: pass", timeout=2.5) == "partial\n"

    native.exec.assert_awaited_once()
    assert native.exec.await_args.kwargs["timeout_secs"] == 2.5


def test_sync_codebox_run_forwards_timeout_to_native_exec():
    native = _native_box()
    box = SyncCodeBox.__new__(SyncCodeBox)
    box._box = SimpleNamespace(_box=native)
    box._runtime = SimpleNamespace(_sync=asyncio.run)

    assert box.run("while True: pass", timeout=2.5) == "partial\n"

    native.exec.assert_awaited_once()
    assert native.exec.await_args.kwargs["timeout_secs"] == 2.5
