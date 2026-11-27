from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..boxlite import MountInfo, MountRequest
    from ._box import SyncBox

__all__ = ["SyncMountHandle"]


class SyncMountHandle:
    """Runtime directory mounts on an existing Box.

    ``state`` is ``"configured"`` while a mount is saved for the Box's next
    start, ``"preparing"`` until the guest confirms it, ``"mounted"`` once it
    is visible in the container and ``"detaching"`` while its removal is
    incomplete. No operation starts the Box.
    """

    def __init__(self, box: "SyncBox") -> None:
        self._box = box

    def add(self, request: "MountRequest") -> "MountInfo":
        """Deliver a directory; a stopped Box saves it and answers ``configured``."""
        return self._box._sync(self._box._box.mount.add(request))

    def remove(self, target: str) -> None:
        """Lazily detach the mount at target, or drop it while still saved.

        Raises ``NotFoundError`` when no mount is there.
        """
        self._box._sync(self._box._box.mount.remove(target))

    def list(self) -> "list[MountInfo]":
        """List the Box's runtime mounts, saved or live."""
        return self._box._sync(self._box._box.mount.list())

    def get(self, target: str) -> "MountInfo | None":
        """Read the mount at target, if present."""
        return self._box._sync(self._box._box.mount.get(target))
