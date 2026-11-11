"""
Unit tests: the timeout survives the whole Python-to-Rust boundary.

The wrapper-level tests in this file prove that ``run()`` hands its timeout to
``exec()``. That is only half the path. ``exec()`` is itself a Python wrapper:
it renames ``timeout`` to ``timeout_secs`` when it calls into the Rust
``Box.exec()``. A break anywhere in that chain -- in the wrapper, in the
rename, or in the call -- would still leave a dead code snippet running
forever, so this file asserts on the value that actually reaches Rust.

Both boundaries are exercised without a VM by substituting the native box
object with a recorder. The native extension is not required: the recorder
stands in for it, and the assertion is made on the keyword the Rust binding
receives.

The sync path needs ``greenlet`` (the ``sync`` extra). The CI matrix does not
install it, so the sync tests skip rather than fail when it is absent.
"""

from __future__ import annotations

import asyncio

import pytest

from boxlite.codebox import CodeBox


class _FakeExecution:
    """Stands in for the PyO3 ``Execution`` handle returned by Rust."""

    def stdout(self):
        return None

    def stderr(self):
        return None

    async def wait(self):
        class _Result:
            exit_code = 0
            error_message = None

        return _Result()


class _RecordingNativeBox:
    """Records the keyword arguments the Rust binding would receive."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def exec(self, cmd, arg_list, env_list, **kwargs):
        self.calls.append({"cmd": cmd, "args": arg_list, "env": env_list, **kwargs})
        return _FakeExecution()


@pytest.mark.asyncio
async def test_async_timeout_reaches_native_boundary_as_timeout_secs():
    """CodeBox.run's timeout must arrive at Rust as ``timeout_secs``."""
    native = _RecordingNativeBox()

    cb = object.__new__(CodeBox)
    # SimpleBox.exec talks to the native box via ``self._box.exec(...)``.
    cb._box = native
    cb._started = True

    out = await CodeBox.run(cb, "print('hi')", timeout=2.5)

    assert out == ""
    assert len(native.calls) == 1
    call = native.calls[0]

    # The Python-facing name is ``timeout``; the Rust binding's name is
    # ``timeout_secs``. Assert the NATIVE name, not the wrapper name.
    assert "timeout_secs" in call, (
        f"timeout did not reach the native boundary as timeout_secs; "
        f"native call received {sorted(call)}"
    )
    assert call["timeout_secs"] == 2.5, (
        f"timeout reached the native boundary as {call['timeout_secs']!r}, expected 2.5"
    )
    # The Python-only alias must not leak through to the Rust binding.
    assert "timeout" not in call, (
        "the native call received a 'timeout' kwarg; the Rust binding "
        "expects 'timeout_secs' and would raise TypeError"
    )


@pytest.mark.asyncio
async def test_async_no_timeout_reaches_native_boundary_as_none():
    """An omitted timeout must still arrive explicitly, as None."""
    native = _RecordingNativeBox()

    cb = object.__new__(CodeBox)
    cb._box = native
    cb._started = True

    await CodeBox.run(cb, "print('hi')")

    call = native.calls[0]
    assert "timeout_secs" in call, (
        f"timeout_secs absent from the native call; received {sorted(call)}"
    )
    assert call["timeout_secs"] is None


# -- Sync wrapper coverage -----------------------------------------------------
#
# greenlet is an OPTIONAL dependency (the "sync" extra) and the CI matrix does
# not install it, so these tests must skip rather than fail when it is absent.
try:
    from boxlite.sync_api._codebox import SyncCodeBox

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False

sync_only = pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")


class _FakeSyncNativeBox:
    """Records the keyword arguments the Rust binding would receive (sync)."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def exec(self, cmd, arg_list, env_list, **kwargs):
        self.calls.append({"cmd": cmd, "args": arg_list, "env": env_list, **kwargs})
        return _FakeExecution()


class _FakeSyncRuntime:
    """Runs the coroutine on a real event loop, like the greenlet bridge does."""

    def __init__(self, loop):
        self._loop = loop

    def _sync(self, coro):
        return self._loop.run_until_complete(coro)


@sync_only
def test_sync_timeout_reaches_native_boundary_as_timeout_secs():
    """SyncCodeBox.run's timeout must arrive at Rust as ``timeout_secs``."""
    native = _FakeSyncNativeBox()

    box = SyncCodeBox.__new__(SyncCodeBox)
    # SyncSimpleBox.exec reaches Rust via ``self._box._box.exec(...)``.
    box._box = type("_Holder", (), {"_box": native})()
    box._runtime = _FakeSyncRuntime(asyncio.new_event_loop())

    try:
        out = box.run("print('hi')", timeout=2.5)
    finally:
        box._runtime._loop.close()

    assert out == ""
    assert len(native.calls) == 1
    call = native.calls[0]

    assert "timeout_secs" in call, (
        f"timeout did not reach the native boundary as timeout_secs; "
        f"native call received {sorted(call)}"
    )
    assert call["timeout_secs"] == 2.5, (
        f"timeout reached the native boundary as {call['timeout_secs']!r}, expected 2.5"
    )
    assert "timeout" not in call, (
        "the native call received a 'timeout' kwarg; the Rust binding "
        "expects 'timeout_secs' and would raise TypeError"
    )


@sync_only
def test_sync_no_timeout_reaches_native_boundary_as_none():
    """An omitted timeout must still arrive explicitly, as None."""
    native = _FakeSyncNativeBox()

    box = SyncCodeBox.__new__(SyncCodeBox)
    box._box = type("_Holder", (), {"_box": native})()
    box._runtime = _FakeSyncRuntime(asyncio.new_event_loop())

    try:
        box.run("print('hi')")
    finally:
        box._runtime._loop.close()

    call = native.calls[0]
    assert "timeout_secs" in call, (
        f"timeout_secs absent from the native call; received {sorted(call)}"
    )
    assert call["timeout_secs"] is None
