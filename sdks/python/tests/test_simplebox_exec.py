"""Unit tests for the SimpleBox execution wrapper."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from boxlite.sync_api._simplebox import SyncSimpleBox

from boxlite import exec as exec_api
from boxlite import simplebox


def started_box(execution):
    box = simplebox.SimpleBox.__new__(simplebox.SimpleBox)
    box._started = True
    box._box = SimpleNamespace(exec=AsyncMock(return_value=execution))
    return box


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["stdout", "stderr"])
async def test_timed_exec_returns_with_output_pipe_still_open(monkeypatch, channel):
    monkeypatch.setattr(exec_api, "_EXEC_COMPLETION_GRACE_SECONDS", 0.05, raising=False)
    reader_waiting = asyncio.Event()
    close_pipe = asyncio.Event()

    async def held_output():
        yield b"before timeout\\n"
        reader_waiting.set()
        await close_pipe.wait()

    execution = SimpleNamespace(
        stdin=lambda: SimpleNamespace(close=AsyncMock()),
        stdout=lambda: None,
        stderr=lambda: None,
        wait=AsyncMock(return_value=SimpleNamespace(exit_code=-15, error_message=None)),
    )
    setattr(execution, channel, held_output)
    box = started_box(execution)
    task = asyncio.create_task(box.exec("sh", "-c", "sleep 30; echo done", timeout=0.1))
    try:
        await asyncio.wait_for(reader_waiting.wait(), 2)
        completed, _ = await asyncio.wait({task}, timeout=1)
    finally:
        close_pipe.set()
        result = await asyncio.wait_for(task, 2)

    assert task in completed, (
        f"SimpleBox.exec still waits for {channel} after the deadline"
    )
    assert result.exit_code == -15
    assert getattr(result, channel) == "before timeout\\n"
    assert result.error_message == "Timed out collecting command output"


@pytest.mark.asyncio
async def test_timed_exec_returns_when_native_status_stalls(monkeypatch):
    monkeypatch.setattr(exec_api, "_EXEC_COMPLETION_GRACE_SECONDS", 0.05, raising=False)
    wait_started = asyncio.Event()
    allow_exit = asyncio.Event()

    async def stalled_wait():
        wait_started.set()
        await allow_exit.wait()
        return SimpleNamespace(exit_code=0, error_message=None)

    execution = SimpleNamespace(
        stdin=lambda: SimpleNamespace(close=AsyncMock()),
        stdout=lambda: None,
        stderr=lambda: None,
        wait=stalled_wait,
    )
    box = started_box(execution)
    task = asyncio.create_task(box.exec("sleep", "30", timeout=0.1))
    try:
        await asyncio.wait_for(wait_started.wait(), 2)
        completed, _ = await asyncio.wait({task}, timeout=1)
    finally:
        allow_exit.set()
        result = await asyncio.wait_for(task, 2)

    assert task in completed, (
        "SimpleBox.exec still waits for native status after the deadline"
    )
    assert result.exit_code == -1
    assert result.error_message == "Timed out waiting for the command result"


def test_sync_timed_exec_returns_with_output_pipe_still_open(monkeypatch):
    monkeypatch.setattr(exec_api, "_EXEC_COMPLETION_GRACE_SECONDS", 0.05, raising=False)

    async def held_output():
        yield b"before timeout\n"
        await asyncio.sleep(1)
        yield b"after deadline\n"

    execution = SimpleNamespace(
        stdin=lambda: SimpleNamespace(close=AsyncMock()),
        stdout=held_output,
        stderr=lambda: None,
        wait=AsyncMock(return_value=SimpleNamespace(exit_code=-15, error_message=None)),
    )
    native = SimpleNamespace(exec=AsyncMock(return_value=execution))
    box = SyncSimpleBox.__new__(SyncSimpleBox)
    box._box = SimpleNamespace(_box=native)
    box._runtime = SimpleNamespace(_sync=asyncio.run)

    result = box.exec("sh", "-c", "sleep 30; echo done", timeout=0.1)

    assert result.stdout == "before timeout\n"
    assert result.exit_code == -15
    assert result.error_message == "Timed out collecting command output"


@pytest.mark.parametrize("timeout", [None, 0.0])
@pytest.mark.parametrize("api", ["async", "sync"])
def test_exec_without_deadline_collects_the_complete_result(monkeypatch, timeout, api):
    monkeypatch.setattr(exec_api, "_EXEC_COMPLETION_GRACE_SECONDS", 0.01)

    async def stdout():
        yield "before\n"
        await asyncio.sleep(0.08)
        yield "finished\n"

    async def wait():
        await asyncio.sleep(0.08)
        return SimpleNamespace(exit_code=0, error_message=None)

    execution = SimpleNamespace(
        stdin=lambda: SimpleNamespace(close=AsyncMock()),
        stdout=stdout,
        stderr=lambda: None,
        wait=wait,
    )
    if api == "async":
        box = started_box(execution)
        result = asyncio.run(box.exec("work", timeout=timeout))
    else:
        native = SimpleNamespace(exec=AsyncMock(return_value=execution))
        box = SyncSimpleBox.__new__(SyncSimpleBox)
        box._box = SimpleNamespace(_box=native)
        box._runtime = SimpleNamespace(_sync=asyncio.run)
        result = box.exec("work", timeout=timeout)

    assert result.exit_code == 0
    assert result.stdout == "before\nfinished\n"
    assert result.error_message is None
