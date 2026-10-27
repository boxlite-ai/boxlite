from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace

import pytest

from boxlite.simplebox import SimpleBox

# Wrappers pass addresses and options through; native binding tests check types.
TARGET = ("127.0.0.1", 3000)


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

    def is_public(self) -> bool:
        return self.is_public_value

    def token(self) -> str | None:
        return None if self.is_public_value else "blt_service-issued-secret"

    async def connect(self) -> _FakeConnection:
        return self.connections.pop(0)

    async def forward(self, listen):
        return _FakeForwarder(listen)


class _FakeNetwork:
    def __init__(self, tunnel: _FakeTunnel) -> None:
        self.tunnel_value = tunnel
        self.targets: list[object] = []
        self.options: list[object] = []
        self.revoked: list[int] = []

    async def tunnel(self, target, options=None) -> _FakeTunnel:
        self.targets.append(target)
        self.options.append(options)
        self.tunnel_value.is_public_value = options is None or options.is_public
        return self.tunnel_value

    async def revoke_tunnel(self, port: int) -> None:
        self.revoked.append(port)


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

    tunnel = await box.network.tunnel(TARGET)
    assert tunnel.uri() == "https://3000-box.proxy.example.test"
    assert box._box.network.targets == [TARGET]

    # Reading the address must leave the tunnel usable, not consume it.
    assert await tunnel.connect() is connection


@pytest.mark.asyncio
async def test_uri_is_none_for_a_local_tunnel():
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([], None))

    tunnel = await box.network.tunnel(TARGET)
    assert tunnel.uri() is None


@pytest.mark.asyncio
async def test_private_tunnel_preserves_policy_and_returned_metadata():
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([], "https://private.proxy.test"))
    options = SimpleNamespace(is_public=False)
    tunnel = await box.tunnel(TARGET, options)
    assert tunnel.is_public() is False
    assert tunnel.token() == "blt_service-issued-secret"
    assert box._box.network.targets == [TARGET]
    assert box._box.network.options == [options]
    await tunnel.forward("test-listener")
    assert box._box.network.targets == [TARGET]


@pytest.mark.asyncio
async def test_connect_consumes_tunnel_once():
    first_connection = _FakeConnection()
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([first_connection], "unused"))

    tunnel = await box.network.tunnel(TARGET)
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
        await box.network.tunnel(TARGET)


@pytest.mark.asyncio
async def test_forward_delegates_and_preserves_lifecycle_calls():
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([], None))
    listen = object()

    tunnel = await box.network.tunnel(TARGET)
    forwarder = await tunnel.forward(listen)
    assert forwarder.local_addr() is listen
    await forwarder.wait()
    await forwarder.close()
    assert forwarder.waited
    assert forwarder.closed


@pytest.mark.parametrize("options", [None, SimpleNamespace(is_public=False)])
def test_sync_tunnel_passes_target_and_options(options):
    pytest.importorskip("greenlet")
    from boxlite.sync_api._box import SyncBox
    from boxlite.sync_api._simplebox import SyncSimpleBox

    box = SyncBox.__new__(SyncBox)
    box._box = _FakeBox(_FakeTunnel([], "https://3000-box.proxy.test"))
    box._network = None
    box._sync_helper = SimpleNamespace(_sync=asyncio.run)
    simple_box = SyncSimpleBox.__new__(SyncSimpleBox)
    simple_box._box = box

    tunnel = simple_box.tunnel(TARGET, options)
    assert box._box.network.targets == [TARGET]
    assert box._box.network.options == [options]
    assert tunnel.uri() == "https://3000-box.proxy.test"
    assert tunnel.is_public() is (options is None or options.is_public)


@pytest.mark.asyncio
async def test_revoke_tunnel_withdraws_the_port_on_a_stopped_box():
    box = SimpleBox.__new__(SimpleBox)
    box._started = False
    box._box = _FakeBox(_FakeTunnel([], None))

    await box.network.revoke_tunnel(3000)

    assert box._box.network.revoked == [3000]


@pytest.mark.asyncio
@pytest.mark.parametrize("port", [0, 65536, "3000", None])
async def test_revoke_tunnel_rejects_invalid_ports(port):
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = _FakeBox(_FakeTunnel([], None))

    with pytest.raises(ValueError, match="integer between 1 and 65535"):
        await box.network.revoke_tunnel(port)
    assert box._box.network.revoked == []


def test_sync_revoke_tunnel_withdraws_the_port():
    pytest.importorskip("greenlet")
    from boxlite.sync_api._network import SyncNetworkHandle

    class Owner:
        def __init__(self) -> None:
            self.revoked: list[int] = []

        def _revoke_tunnel(self, port):
            self.revoked.append(port)

    owner = Owner()
    SyncNetworkHandle(owner).revoke_tunnel(3000)
    assert owner.revoked == [3000]

    with pytest.raises(ValueError, match="integer between 1 and 65535"):
        SyncNetworkHandle(owner).revoke_tunnel(0)
    assert owner.revoked == [3000]
