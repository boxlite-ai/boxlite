"""Synchronous access to independent managed checkpoints."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..boxlite import CheckpointHandle, CheckpointInfo
    from ._box import SyncBox
    from ._boxlite import SyncBoxlite


class SyncCheckpointHandle:
    def __init__(self, runtime: "SyncBoxlite", handle: "CheckpointHandle") -> None:
        from ._sync_base import SyncBase

        self._runtime = runtime
        self._handle = handle
        self._bridge = SyncBase(handle, runtime.loop, runtime.dispatcher_fiber)

    def create(self, source: str, name: str | None = None) -> "CheckpointInfo":
        return self._bridge._sync(self._handle.create(source, name))

    def list(self) -> list["CheckpointInfo"]:
        return self._bridge._sync(self._handle.list())

    def get(self, key: str) -> "CheckpointInfo":
        return self._bridge._sync(self._handle.get(key))

    def remove(self, key: str, force: bool = False) -> None:
        self._bridge._sync(self._handle.remove(key, force))

    def import_box(
        self, key: str, name: str | None = None, *, box_id: str | None = None
    ) -> "SyncBox":
        from ._box import SyncBox

        handle = self._bridge._sync(self._handle.import_box(key, name, box_id=box_id))
        return SyncBox(self._runtime, handle)
