from __future__ import annotations

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
    def __init__(self, connections: list[_FakeConnection], endpoint: str | int) -> None:
        self.connections = connections
        self.endpoint_value = endpoint

    def endpoint(self) -> str | int:
        return self.endpoint_value

    async def connect(self) -> _FakeConnection:
        return self.connections.pop(0)


class _FakeNetwork:
    def __init__(self, tunnel: _FakeTunnel) -> None:
        self.tunnel_value = tunnel
        self.ports: list[int] = []

    async def tunnel(self, port: int) -> _FakeTunnel:
        self.ports.append(port)
        return self.tunnel_value


class _FakeBox:
    def __init__(self, tunnel: _FakeTunnel) -> None:
        self.network = _FakeNetwork(tunnel)


@pytest.mark.asyncio
async def test_endpoint_returns_local_file_descriptor():
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([], 42))

    tunnel = await box.network.tunnel(3000)
    assert tunnel.endpoint() == 42
    assert box._box.network.ports == [3000]


@pytest.mark.asyncio
async def test_connect_consumes_tunnel_once():
    connection = _FakeConnection()
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([connection], "unused"))

    tunnel = await box.network.tunnel(3000)
    first = await tunnel.connect()
    try:
        assert await first.write(b"one") == 3
        assert connection.writes == [b"one"]
        with pytest.raises(IndexError):
            await tunnel.connect()
    finally:
        await first.close()
        assert connection.closed


@pytest.mark.asyncio
async def test_tunnel_requires_a_started_box():
    box = SimpleBox.__new__(SimpleBox)
    box._started = False

    with pytest.raises(RuntimeError, match="Box not started"):
        await box.network.tunnel(3000)


@pytest.mark.parametrize("port", [0, 65536, "3000", None])
def test_sync_tunnel_rejects_invalid_ports(port):
    pytest.importorskip("greenlet")
    from boxlite.sync_api._network import SyncNetworkHandle

    class Owner:
        def _create_tunnel(self, _port):
            raise AssertionError("native tunnel creation should not be called")

    with pytest.raises(ValueError, match="integer between 1 and 65535"):
        SyncNetworkHandle(Owner()).tunnel(port)
