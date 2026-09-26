"""SimpleBox's streaming-copy wrappers, driven with no box behind them.

`copy_in_stream`, `copy_out_stream` and `_as_chunks` are pure Python glue over
the native `Box`. The integration suite runs them against a real box, which CI
cannot boot, so here the native side is a recording fake and `boxlite.boxlite`
is a stub module. The assertions are about what the glue hands across that
boundary: the chunk sequence, the options it builds, and when it closes or
aborts the stream.
"""

import io
import sys
import types
from collections import deque

import pytest

from boxlite.simplebox import _COPY_CHUNK_BYTES, SimpleBox, _as_chunks

pytestmark = pytest.mark.asyncio


class RecordingCopyOptions:
    """Stands in for the native ``CopyOptions``; keeps the kwargs the wrapper built."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


@pytest.fixture
def native_stub(monkeypatch):
    """Route the wrappers' in-function ``from .boxlite import CopyOptions`` to a stub.

    That import resolves ``boxlite.boxlite`` through ``sys.modules`` at call
    time, so the stub wins both in CI, where no extension is built, and
    locally, where one is.
    """
    stub = types.ModuleType("boxlite.boxlite")
    stub.CopyOptions = RecordingCopyOptions
    monkeypatch.setitem(sys.modules, "boxlite.boxlite", stub)
    return stub


class FakeInStream:
    def __init__(self, fail_write_with=None):
        self.writes = []
        self.closes = 0
        self.aborts = 0
        self.fail_write_with = fail_write_with

    async def write(self, chunk):
        if self.fail_write_with is not None:
            raise self.fail_write_with
        self.writes.append(chunk)

    async def close(self):
        self.closes += 1

    async def abort(self):
        self.aborts += 1


class FakeNativeBox:
    """The native ``Box`` as the wrappers see it.

    ``copy_in_stream`` is deliberately a plain ``def``: the binding hands the
    stream object back directly and ``SimpleBox`` does not await it, while
    ``copy_out_stream`` is awaited. The fake pins that contract.
    """

    def __init__(self, in_stream=None):
        self.calls = []
        self.in_stream = in_stream if in_stream is not None else FakeInStream()
        self.out_stream = object()

    def copy_in_stream(self, container_dest, source_is_dir, opts):
        self.calls.append(("copy_in_stream", container_dest, source_is_dir, opts))
        return self.in_stream

    async def copy_out_stream(self, container_src, opts):
        self.calls.append(("copy_out_stream", container_src, opts))
        return self.out_stream


def started_box(native, started=True):
    # __init__ needs the native runtime; the wrappers only need these two.
    box = object.__new__(SimpleBox)
    box._box = native
    box._started = started
    return box


async def drain(source):
    return [chunk async for chunk in _as_chunks(source)]


class ReadRecorder:
    """A file-like source that remembers how much each ``read`` asked for."""

    def __init__(self, payload):
        self._buffer = io.BytesIO(payload)
        self.sizes = []

    def read(self, size):
        self.sizes.append(size)
        return self._buffer.read(size)


class AsyncReader:
    def __init__(self, chunks):
        self._chunks = deque(chunks)

    async def read(self, size):
        return self._chunks.popleft() if self._chunks else b""


# ── _as_chunks ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "source",
    [b"abc", bytearray(b"abc"), memoryview(b"abc")],
    ids=["bytes", "bytearray", "memoryview"],
)
async def test_bytes_like_sources_become_a_single_bytes_chunk(source):
    chunks = await drain(source)

    assert chunks == [b"abc"]
    assert type(chunks[0]) is bytes


async def test_a_file_like_source_is_read_in_copy_chunk_sized_reads():
    payload = b"x" * (2 * _COPY_CHUNK_BYTES + 5)
    source = ReadRecorder(payload)

    chunks = await drain(source)

    assert [len(chunk) for chunk in chunks] == [_COPY_CHUNK_BYTES, _COPY_CHUNK_BYTES, 5]
    assert b"".join(chunks) == payload
    assert set(source.sizes) == {_COPY_CHUNK_BYTES}, (
        "every read asks for one transfer chunk"
    )


async def test_an_awaitable_read_is_awaited_before_being_forwarded():
    chunks = await drain(AsyncReader([b"first", bytearray(b"second")]))

    assert chunks == [b"first", b"second"]


async def test_an_async_iterable_source_is_forwarded_chunk_by_chunk():
    async def source():
        yield bytearray(b"a")
        yield b"bb"

    chunks = await drain(source())

    assert chunks == [b"a", b"bb"]
    assert all(type(chunk) is bytes for chunk in chunks)


async def test_a_sync_iterable_source_is_forwarded_chunk_by_chunk():
    chunks = await drain(iter([b"a", bytearray(b"bb"), b"ccc"]))

    assert chunks == [b"a", b"bb", b"ccc"]


async def test_an_unsupported_source_is_refused_by_type_name():
    with pytest.raises(TypeError, match=r"not int"):
        await drain(42)


# ── copy_in_stream / copy_out_stream ────────────────────────────────


async def test_copy_in_stream_forwards_every_chunk_in_order_then_closes_once(
    native_stub,
):
    native = FakeNativeBox()
    box = started_box(native)

    await box.copy_in_stream(
        "/dest", [b"a", b"bb", b"ccc"], source_is_dir=True, overwrite=False
    )

    assert native.in_stream.writes == [b"a", b"bb", b"ccc"]
    assert (native.in_stream.closes, native.in_stream.aborts) == (1, 0)
    ((name, dest, source_is_dir, opts),) = native.calls
    assert (name, dest, source_is_dir) == ("copy_in_stream", "/dest", True)
    assert opts.kwargs == {"recursive": True, "overwrite": False}


async def test_copy_in_stream_aborts_and_reraises_when_the_source_fails_midway(
    native_stub,
):
    boom = ValueError("source broke")

    async def source():
        yield b"head"
        raise boom

    native = FakeNativeBox()
    box = started_box(native)

    with pytest.raises(ValueError) as caught:
        await box.copy_in_stream("/dest", source(), source_is_dir=False)

    assert caught.value is boom
    assert native.in_stream.writes == [b"head"]
    assert (native.in_stream.closes, native.in_stream.aborts) == (0, 1)


async def test_copy_in_stream_aborts_when_a_write_is_refused(native_stub):
    refused = OSError("the copy ended before this chunk")
    native = FakeNativeBox(FakeInStream(fail_write_with=refused))
    box = started_box(native)

    with pytest.raises(OSError) as caught:
        await box.copy_in_stream("/dest", b"payload")

    assert caught.value is refused
    assert (native.in_stream.closes, native.in_stream.aborts) == (0, 1)


async def test_copy_in_stream_refuses_a_box_that_was_not_started():
    native = FakeNativeBox()
    box = started_box(native, started=False)

    with pytest.raises(RuntimeError, match="Box not started"):
        await box.copy_in_stream("/dest", b"payload")

    assert native.calls == []


async def test_copy_out_stream_refuses_a_box_that_was_not_started():
    native = FakeNativeBox()
    box = started_box(native, started=False)

    with pytest.raises(RuntimeError, match="Box not started"):
        await box.copy_out_stream("/src")

    assert native.calls == []


async def test_copy_out_stream_forwards_pack_options_and_returns_the_native_stream(
    native_stub,
):
    native = FakeNativeBox()
    box = started_box(native)

    result = await box.copy_out_stream(
        "/src", include_parent=False, follow_symlinks=True
    )

    assert result is native.out_stream
    ((name, src, opts),) = native.calls
    assert (name, src) == ("copy_out_stream", "/src")
    assert opts.kwargs == {
        "recursive": True,
        "follow_symlinks": True,
        "include_parent": False,
    }
