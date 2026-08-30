"""SyncNetworkHandle - synchronous network operations for a box."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._box import SyncBox

__all__ = ["SyncBoxTunnel", "SyncNetworkHandle", "SyncTunnelForwarder"]


class SyncTunnelForwarder:
    def __init__(self, box: "SyncBox", forwarder) -> None:
        self._box = box
        self._forwarder = forwarder

    def local_addr(self):
        return self._forwarder.local_addr()

    def wait(self) -> None:
        self._box._sync(self._forwarder.wait())

    def close(self) -> None:
        self._box._sync(self._forwarder.close())


class SyncBoxTunnel:
    """Prepared one-shot synchronous tunnel handle."""

    def __init__(self, box: "SyncBox", tunnel) -> None:
        self._box = box
        self._tunnel = tunnel

    def connect(self):
        """Consume the tunnel and return its bidirectional byte stream."""
        return self._box._sync(self._tunnel.connect())

    def uri(self):
        """Return the public URL of a remote tunnel, or ``None`` for a local one."""
        return self._tunnel.uri()

    def forward(self, listen) -> SyncTunnelForwarder:
        return SyncTunnelForwarder(
            self._box, self._box._sync(self._tunnel.forward(listen))
        )


class SyncNetworkHandle:
    """Synchronous wrapper for a box's network handle."""

    def __init__(self, box: "SyncBox") -> None:
        self._owner = box

    def tunnel(self, port: int) -> SyncBoxTunnel:
        """Establish and return a one-shot tunnel for a port inside the box."""
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("port must be an integer between 1 and 65535")
        tunnel = self._owner._create_tunnel(port)
        return SyncBoxTunnel(self._owner, tunnel)
