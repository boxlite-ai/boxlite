"""SyncSshHandle - synchronous SSH control for a box."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from boxlite import SshConfig, SshStatus

    from ._box import SyncBox

__all__ = ["SyncSshHandle"]


class SyncSshHandle:
    """Synchronous wrapper for a box's SSH control handle."""

    def __init__(self, box: "SyncBox") -> None:
        self._owner = box

    def configure(self, config: "SshConfig") -> "SshStatus":
        """Replace SSH configuration; may implicitly start the box."""
        return self._owner._sync(self._owner._box.ssh.configure(config))

    def status(self) -> "SshStatus":
        """Query SSH state without starting the box."""
        return self._owner._sync(self._owner._box.ssh.status())

    def disable(self) -> "SshStatus":
        """Stop SSH and disconnect clients; repeatable, never starts the box."""
        return self._owner._sync(self._owner._box.ssh.disable())
