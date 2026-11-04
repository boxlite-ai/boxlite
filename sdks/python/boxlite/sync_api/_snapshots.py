"""Synchronous box and organization snapshot operations."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..boxlite import (
        RuntimeSnapshotHandle,
        SnapshotHandle,
        SnapshotInfo,
        SnapshotOptions,
    )
    from ._boxlite import SyncBoxlite


class SyncSnapshotHandle:
    """Snapshots taken from one box; restore writes to that box."""

    def __init__(self, runtime: "SyncBoxlite", handle: "SnapshotHandle") -> None:
        self._runtime = runtime
        self._handle = handle

    def create(
        self, *, options: "SnapshotOptions | None" = None, name: str | None = None
    ) -> "SnapshotInfo":
        self._runtime._require_started()
        return self._runtime._sync(self._handle.create(options=options, name=name))

    def list(self) -> list["SnapshotInfo"]:
        self._runtime._require_started()
        return self._runtime._sync(self._handle.list())

    def get(self, name: str) -> "SnapshotInfo | None":
        self._runtime._require_started()
        return self._runtime._sync(self._handle.get(name))

    def remove(self, name: str) -> None:
        self._runtime._require_started()
        self._runtime._sync(self._handle.remove(name))

    def restore(self, name: str) -> None:
        self._runtime._require_started()
        self._runtime._sync(self._handle.restore(name))


class SyncRuntimeSnapshotHandle:
    """Organization catalog; get raises when the snapshot does not exist."""

    def __init__(self, runtime: "SyncBoxlite", handle: "RuntimeSnapshotHandle") -> None:
        self._runtime = runtime
        self._handle = handle

    def list(self) -> list["SnapshotInfo"]:
        self._runtime._require_started()
        return self._runtime._sync(self._handle.list())

    def get(self, id_or_name: str) -> "SnapshotInfo":
        self._runtime._require_started()
        return self._runtime._sync(self._handle.get(id_or_name))

    def remove(self, id_or_name: str, force: bool = False) -> None:
        self._runtime._require_started()
        self._runtime._sync(self._handle.remove(id_or_name, force=force))
