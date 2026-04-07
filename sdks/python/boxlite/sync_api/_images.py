"""
SyncImageHandle - Synchronous wrapper for runtime image operations.
"""

from typing import TYPE_CHECKING, List

if TYPE_CHECKING:
    from ._boxlite import SyncBoxlite
    from ..boxlite import ImageHandle, ImageInfo, ImagePullResult

__all__ = ["SyncImageHandle"]


class SyncImageHandle:
    """
    Synchronous wrapper for ImageHandle.

    Mirrors the async runtime image API using greenlet-based sync bridging.
    """

    def __init__(self, runtime: "SyncBoxlite", handle: "ImageHandle") -> None:
        from ._sync_base import SyncBase

        self._runtime = runtime
        self._handle = handle
        self._sync_helper = SyncBase(handle, runtime.loop, runtime.dispatcher_fiber)

    def _sync(self, coro):
        return self._sync_helper._sync(coro)

    def pull(self, reference: str) -> "ImagePullResult":
        return self._sync(self._handle.pull(reference))

    def list(self) -> List["ImageInfo"]:
        return self._sync(self._handle.list())
