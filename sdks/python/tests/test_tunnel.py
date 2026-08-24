from __future__ import annotations

import inspect

import pytest

from boxlite.simplebox import SimpleBox


class _FakeConnection:
    def __init__(self) -> None:
        self.writes: list[bytes] = []
        self.closed = False

    async def write(self, data: bytes) -> int:
        self.writes.append(data)
        return len(data)

    async def close(self) -> None:
        self.closed = True


class _FakeTunnel:
    def __init__(self, connections: list[_FakeConnection], uri: str | None) -> None:
        self.connections = connections
        self.uri_value = uri

    def uri(self) -> str | None:
        return self.uri_value

    async def connect(self) -> _FakeConnection:
        return self.connections.pop(0)

    async def forward(self, listen):
        return _FakeForwarder(listen)


class _FakeNetwork:
    def __init__(self, tunnel: _FakeTunnel) -> None:
        self.tunnel_value = tunnel
        self.ports: list[int] = []

    async def tunnel(self, port: int) -> _FakeTunnel:
        self.ports.append(port)
        return self.tunnel_value


class _FakeForwarder:
    def __init__(self, listen) -> None:
        self.listen = listen
        self.waited = False
        self.closed = False

    def local_addr(self):
        return self.listen

    async def wait(self) -> None:
        self.waited = True

    async def close(self) -> None:
        self.closed = True


class _FakeBox:
    def __init__(self, tunnel: _FakeTunnel) -> None:
        self.network = _FakeNetwork(tunnel)


class _FakeInfoBox:
    def __init__(self, info) -> None:
        self.info_value = info

    async def info(self):
        return self.info_value


@pytest.mark.asyncio
async def test_info_is_async():
    marker = object()
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeInfoBox(marker)

    assert inspect.iscoroutinefunction(SimpleBox.info)
    assert await box.info() is marker


@pytest.mark.asyncio
async def test_info_rejects_when_box_is_not_started():
    box = SimpleBox.__new__(SimpleBox)
    box._started = False

    info = box.info()
    assert inspect.isawaitable(info)
    with pytest.raises(RuntimeError, match="Box not started"):
        _ = await info


@pytest.mark.asyncio
async def test_uri_returns_remote_url_without_consuming_the_tunnel():
    connection = _FakeConnection()
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(
        _FakeTunnel([connection], "https://3000-box.proxy.example.test")
    )

    tunnel = await box.network.tunnel(3000)
    assert tunnel.uri() == "https://3000-box.proxy.example.test"
    assert box._box.network.ports == [3000]

    # Reading the address must leave the tunnel usable, not consume it.
    assert await tunnel.connect() is connection


@pytest.mark.asyncio
async def test_uri_is_none_for_a_local_tunnel():
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([], None))

    tunnel = await box.network.tunnel(3000)
    assert tunnel.uri() is None


@pytest.mark.asyncio
async def test_connect_consumes_tunnel_once():
    first_connection = _FakeConnection()
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([first_connection], "unused"))

    tunnel = await box.network.tunnel(3000)
    first = await tunnel.connect()
    try:
        assert await first.write(b"one") == 3
        assert first_connection.writes == [b"one"]
        with pytest.raises(IndexError):
            await tunnel.connect()
    finally:
        await first.close()
        assert first_connection.closed


@pytest.mark.asyncio
async def test_tunnel_requires_a_started_box():
    box = SimpleBox.__new__(SimpleBox)
    box._started = False

    with pytest.raises(RuntimeError, match="Box not started"):
        await box.network.tunnel(3000)


@pytest.mark.asyncio
async def test_forward_delegates_and_preserves_lifecycle_calls():
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([], None))
    listen = object()

    tunnel = await box.network.tunnel(3000)
    forwarder = await tunnel.forward(listen)
    assert forwarder.local_addr() is listen
    await forwarder.wait()
    await forwarder.close()
    assert forwarder.waited
    assert forwarder.closed


@pytest.mark.parametrize("port", [0, 65536, "3000", None])
def test_sync_tunnel_rejects_invalid_ports(port):
    pytest.importorskip("greenlet")
    from boxlite.sync_api._network import SyncNetworkHandle

    class Owner:
        def _create_tunnel(self, _port):
            raise AssertionError("native tunnel creation should not be called")

    with pytest.raises(ValueError, match="integer between 1 and 65535"):
        SyncNetworkHandle(Owner()).tunnel(port)
