"""
SyncDomainHandle - Synchronous wrapper for the organization's domains.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..boxlite import Domain, DomainHandle, DomainList, DomainTarget
    from ._boxlite import SyncBoxlite

__all__ = ["SyncDomainHandle"]


class SyncDomainHandle:
    """
    Synchronous wrapper for DomainHandle.

    Mirrors the async domain API using greenlet-based sync bridging.
    """

    def __init__(self, runtime: "SyncBoxlite", handle: "DomainHandle") -> None:
        from ._sync_base import SyncBase

        self._runtime = runtime
        self._handle = handle
        self._sync_helper = SyncBase(handle, runtime.loop, runtime.dispatcher_fiber)

    def _sync(self, coro):
        return self._sync_helper._sync(coro)

    def list(self) -> "DomainList":
        return self._sync(self._handle.list())

    def bind(self, domain: str, target: "DomainTarget") -> "Domain":
        return self._sync(self._handle.bind(domain, target))

    def unbind(self, domain: str) -> None:
        return self._sync(self._handle.unbind(domain))
