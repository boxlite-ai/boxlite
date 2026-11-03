"""Synchronous checkpoint catalogs; restoring creates a separate Paused box."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..boxlite import CheckpointHandle, CheckpointInfo, RuntimeCheckpointHandle
    from ._boxlite import SyncBoxlite


class SyncCheckpointHandle:
    """Captures of one explicitly paused box."""

    def __init__(self, runtime: "SyncBoxlite", handle: "CheckpointHandle") -> None:
        self._runtime = runtime
        self._handle = handle

    def create(self, *, name: str | None = None) -> "CheckpointInfo":
        self._runtime._require_started()
        return self._runtime._sync(self._handle.create(name=name))

    def list(self) -> list["CheckpointInfo"]:
        self._runtime._require_started()
        return self._runtime._sync(self._handle.list())

    def get(self, id_or_name: str) -> "CheckpointInfo | None":
        self._runtime._require_started()
        return self._runtime._sync(self._handle.get(id_or_name))

    def remove(self, id_or_name: str, *, force: bool = False) -> None:
        self._runtime._require_started()
        self._runtime._sync(self._handle.remove(id_or_name, force=force))


class SyncRuntimeCheckpointHandle:
    """Source-independent catalog; missing get raises NotFoundError."""

    def __init__(
        self, runtime: "SyncBoxlite", handle: "RuntimeCheckpointHandle"
    ) -> None:
        self._runtime = runtime
        self._handle = handle

    def list(self) -> list["CheckpointInfo"]:
        self._runtime._require_started()
        return self._runtime._sync(self._handle.list())

    def get(self, id_or_name: str) -> "CheckpointInfo":
        self._runtime._require_started()
        return self._runtime._sync(self._handle.get(id_or_name))

    def remove(self, id_or_name: str, *, force: bool = False) -> None:
        self._runtime._require_started()
        self._runtime._sync(self._handle.remove(id_or_name, force=force))
