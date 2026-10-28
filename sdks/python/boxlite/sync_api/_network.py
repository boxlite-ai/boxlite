"""SyncNetworkHandle - synchronous network operations for a box."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from boxlite import (
        InboundNetworkSpec,
        OutboundNetworkSpec,
        TunnelOptions,
    )

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

    def is_public(self) -> bool:
        return self._tunnel.is_public()

    def token(self) -> str | None:
        return self._tunnel.token()

    def forward(self, listen) -> SyncTunnelForwarder:
        return SyncTunnelForwarder(
            self._box, self._box._sync(self._tunnel.forward(listen))
        )


class SyncNetworkHandle:
    """Synchronous wrapper for a box's network handle."""

    def __init__(self, box: "SyncBox") -> None:
        self._owner = box

    def update_inbound(self, spec: "InboundNetworkSpec") -> None:
        """Replace the inbound policy; non-empty allowlists are unsupported."""
        self._owner._sync(self._owner._box.network.update_inbound(spec))

    def update_outbound(self, spec: "OutboundNetworkSpec") -> None:
        """Replace outbound policy. Enabled with an empty list clears restrictions."""
        self._owner._sync(self._owner._box.network.update_outbound(spec))

    def tunnel(
        self,
        target: "tuple[str, int] | tuple[str, int, int, int]",
        options: "TunnelOptions | None" = None,
    ) -> SyncBoxTunnel:
        """Prepare a one-shot tunnel to a TCP service inside the box.

        ``target`` is the service's address as seen from the box; its host must
        be localhost or the guest IP for now. ``options`` defaults to public.
        """
        tunnel = self._owner._create_tunnel(target, options)
        return SyncBoxTunnel(self._owner, tunnel)

    def revoke_tunnel(self, port: int) -> None:
        """Revoke the tunnel for a port; open connections are not closed."""
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("port must be an integer between 1 and 65535")
        self._owner._revoke_tunnel(port)
