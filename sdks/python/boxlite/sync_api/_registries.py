"""
SyncRegistryHandle - Synchronous wrapper for the runtime's registry logins.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..boxlite import RegistryCredential, RegistryHandle
    from ._boxlite import SyncBoxlite

__all__ = ["SyncRegistryHandle"]


class SyncRegistryHandle:
    """
    Synchronous wrapper for RegistryHandle.

    Mirrors the async registry login API using greenlet-based sync bridging.
    """

    def __init__(self, runtime: "SyncBoxlite", handle: "RegistryHandle") -> None:
        from ._sync_base import SyncBase

        self._runtime = runtime
        self._handle = handle
        self._sync_helper = SyncBase(handle, runtime.loop, runtime.dispatcher_fiber)

    def _sync(self, coro):
        return self._sync_helper._sync(coro)

    def list(self) -> list["RegistryCredential"]:
        return self._sync(self._handle.list())

    def create(
        self,
        *,
        registry_host: str,
        username: str,
        password: str,
        repository_prefix: str | None = None,
    ) -> "RegistryCredential":
        return self._sync(
            self._handle.create(
                registry_host=registry_host,
                username=username,
                password=password,
                repository_prefix=repository_prefix,
            )
        )

    def remove(self, id: str) -> None:
        return self._sync(self._handle.remove(id))
