"""SyncNetworkHandle - synchronous network operations for a box."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._box import SyncBox

__all__ = ["SyncBoxTunnel", "SyncNetworkHandle"]


class SyncBoxTunnel:
    """Prepared synchronous tunnel handle for a box service port."""

    def __init__(self, box: "SyncBox", tunnel) -> None:
        self._box = box
        self._tunnel = tunnel

    def connect(self):
        """Consume the tunnel and return its bidirectional byte stream."""
        return self._box._sync(self._tunnel.connect())

    def endpoint(self):
        """Return the cloud URI or borrowed local file descriptor."""
        return self._tunnel.endpoint()


class SyncNetworkHandle:
    """Synchronous wrapper for a box's network handle."""

    def __init__(self, box: "SyncBox") -> None:
        self._owner = box

    def tunnel(self, port: int) -> SyncBoxTunnel:
        """Establish and return a tunnel handle for a port inside the box."""
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("port must be an integer between 1 and 65535")
        tunnel = self._owner._create_tunnel(port)
        return SyncBoxTunnel(self._owner, tunnel)
