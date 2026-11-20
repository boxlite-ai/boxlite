"""Exercise the agent stream's cancellation and close contracts."""

import asyncio

import pytest

from boxlite.agents import AgentEventStream


class ControlledStream:
    def __init__(self):
        self.events = asyncio.Queue()
        self.started = asyncio.Event()
        self.closed = False

    async def next(self):
        self.started.set()
        event = await self.events.get()
        if isinstance(event, Exception):
            raise event
        return event

    async def close(self):
        self.closed = True


async def open_stream(native):
    return native


@pytest.mark.asyncio
async def test_open_error_reaches_opened_and_first_read_then_stops():
    async def failed_open():
        raise RuntimeError("open failed")

    stream = AgentEventStream(failed_open())
    with pytest.raises(RuntimeError, match="open failed"):
        await stream.opened()
    with pytest.raises(RuntimeError, match="open failed"):
        await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


@pytest.mark.asyncio
async def test_cancelled_read_is_delivered_to_next_reader():
    native = ControlledStream()
    stream = AgentEventStream(open_stream(native))
    await stream.opened()
    first = asyncio.create_task(anext(stream))
    await native.started.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    await native.events.put('{"kind":"message","turn_id":"t"}')
    assert await anext(stream) == {"kind": "message", "turn_id": "t"}
    await stream.aclose()
    assert native.closed


@pytest.mark.asyncio
async def test_close_during_pending_read_releases_native_stream():
    native = ControlledStream()
    stream = AgentEventStream(open_stream(native))
    await stream.opened()
    reading = asyncio.create_task(anext(stream))
    await native.started.wait()
    await stream.aclose()
    with pytest.raises(asyncio.CancelledError):
        await reading
    assert native.closed
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


@pytest.mark.asyncio
async def test_concurrent_reads_are_rejected():
    native = ControlledStream()
    stream = AgentEventStream(open_stream(native))
    await stream.opened()
    reading = asyncio.create_task(anext(stream))
    await native.started.wait()
    with pytest.raises(RuntimeError, match="concurrent event reads"):
        await anext(stream)
    await native.events.put('{"kind":"message"}')
    assert await reading == {"kind": "message"}
    await stream.aclose()


@pytest.mark.asyncio
async def test_read_error_follows_events_once():
    native = ControlledStream()
    stream = AgentEventStream(open_stream(native))
    await native.events.put('{"kind":"first"}')
    await native.events.put(RuntimeError("read failed"))
    assert await anext(stream) == {"kind": "first"}
    with pytest.raises(RuntimeError, match="read failed"):
        await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    await stream.aclose()
    assert native.closed


@pytest.mark.asyncio
async def test_natural_end_stops_iteration():
    native = ControlledStream()
    stream = AgentEventStream(open_stream(native))
    await native.events.put(None)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    await stream.aclose()


@pytest.mark.asyncio
async def test_close_cancels_pending_open():
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def pending_open():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    stream = AgentEventStream(pending_open())
    await started.wait()
    await asyncio.wait_for(stream.aclose(), 1)
    assert cancelled.is_set()
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
