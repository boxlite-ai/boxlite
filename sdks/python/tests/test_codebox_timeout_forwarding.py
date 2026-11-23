"""
Unit tests: CodeBox.run() must forward its timeout to exec().

The bug this guards against: ``run(code, timeout=...)`` accepted the argument
and then called ``exec(...)`` without it, so a runaway snippet ran with no
deadline. Both the async and sync wrappers had the same defect.

These tests are unit-level on purpose. Verifying that a timed-out run
*terminates* requires a live VM, so that behaviour is covered by the
integration suite. What went wrong here was not the guest's enforcement --
``exec()`` already honoured ``timeout`` -- it was the wrapper dropping the
argument on the floor. That is observable without a VM, and it is the part
that regressed.
"""

from __future__ import annotations

import inspect

import pytest

from boxlite.codebox import CodeBox


class _RecordingExec:
    """Records what exec() was called with, without starting a VM."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, cmd, *args, **kwargs):
        self.calls.append({"cmd": cmd, "args": args, "kwargs": kwargs})

        class _Result:
            stdout = "ok"
            stderr = ""
            exit_code = 0

        return _Result()


@pytest.mark.asyncio
async def test_run_forwards_timeout_to_exec(monkeypatch):
    """An explicit timeout reaches exec()."""
    recorder = _RecordingExec()

    # Bypass VM construction entirely: we are testing argument plumbing.
    cb = object.__new__(CodeBox)
    cb.exec = recorder  # type: ignore[method-assign]

    out = await CodeBox.run(cb, "print('hi')", timeout=2)

    assert out == "ok"
    assert len(recorder.calls) == 1
    call = recorder.calls[0]
    assert call["kwargs"].get("timeout") == 2, (
        "run() accepted timeout=2 but did not pass it to exec(); "
        f"exec() received {call['kwargs']!r}"
    )


@pytest.mark.asyncio
async def test_run_forwards_none_timeout_as_none(monkeypatch):
    """Omitting the timeout passes None through -- not a dropped kwarg."""
    recorder = _RecordingExec()

    cb = object.__new__(CodeBox)
    cb.exec = recorder  # type: ignore[method-assign]

    await CodeBox.run(cb, "print('hi')")

    call = recorder.calls[0]
    assert "timeout" in call["kwargs"], (
        "exec() was called without a timeout kwarg at all; it must be "
        "forwarded explicitly so the two code paths stay identical"
    )
    assert call["kwargs"]["timeout"] is None


def test_run_signature_accepts_float():
    """exec() is typed float | None; run() must accept the same."""
    ann = inspect.signature(CodeBox.run).parameters["timeout"].annotation
    # Accept either the evaluated type or the string form (PEP 563).
    text = str(ann)
    assert "float" in text or ann is float, (
        f"run() timeout is annotated {text!r}; exec() takes float | None, "
        "so an int-only annotation rejects fractional timeouts"
    )


# -- Sync wrapper coverage ---------------------------------------------------
#
# greenlet is an OPTIONAL dependency (the "sync" extra) and the CI matrix does
# not install it, so these tests must skip rather than fail when it is absent.
# This mirrors the guard used by tests/test_sync_skillbox.py.
try:
    from boxlite.sync_api._codebox import SyncCodeBox

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False

sync_only = pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")


class _RecordingSyncExec:
    """Records what the SYNC exec() was called with, without starting a VM.

    The sync wrapper had the identical defect to the async one and would
    regress just as silently, so it gets its own coverage.
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, cmd, *args, **kwargs):
        self.calls.append({"cmd": cmd, "args": args, "kwargs": kwargs})

        class _Result:
            stdout = "ok"
            stderr = ""
            exit_code = 0

        return _Result()


def _make_sync_codebox(monkeypatch, recorder):
    """Build a SyncCodeBox without touching the native module or a VM."""
    box = SyncCodeBox.__new__(SyncCodeBox)
    monkeypatch.setattr(box, "exec", recorder, raising=False)
    return box


@sync_only
def test_sync_run_forwards_timeout_to_exec(monkeypatch):
    """The sync wrapper must forward an explicit timeout to exec()."""
    recorder = _RecordingSyncExec()
    box = _make_sync_codebox(monkeypatch, recorder)

    box.run("print('hi')", timeout=2.5)

    assert len(recorder.calls) == 1
    assert recorder.calls[0]["kwargs"].get("timeout") == 2.5


@sync_only
def test_sync_run_forwards_none_timeout_as_none(monkeypatch):
    """An omitted timeout is forwarded as None, matching the async path.

    Forwarding it explicitly (rather than leaving it out) keeps the two
    wrappers equivalent in behaviour, so a future change to one cannot
    silently diverge from the other.
    """
    recorder = _RecordingSyncExec()
    box = _make_sync_codebox(monkeypatch, recorder)

    box.run("print('hi')")

    assert len(recorder.calls) == 1
    # Assert the kwarg is PRESENT, not merely that its value is None: a
    # missing key also reads as None, and that is exactly the bug.
    assert "timeout" in recorder.calls[0]["kwargs"], (
        "exec() was called without a timeout kwarg at all; it must be "
        "forwarded explicitly so the two code paths stay identical"
    )
    assert recorder.calls[0]["kwargs"]["timeout"] is None


@sync_only
def test_sync_run_signature_accepts_float():
    """exec() is typed float | None; the sync run() must accept the same."""
    ann = inspect.signature(SyncCodeBox.run).parameters["timeout"].annotation
    # Accept either the evaluated type or the string form (PEP 563).
    text = str(ann)
    assert "float" in text or ann is float, (
        f"run() timeout is annotated {text!r}; exec() takes float | None, "
        "so an int-only annotation rejects fractional timeouts"
    )
