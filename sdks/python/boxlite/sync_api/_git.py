"""SyncGitHandle - synchronous git operations for a box."""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ._box import SyncBox

__all__ = ["SyncGitHandle"]


class SyncGitHandle:
    """Synchronous wrapper for a box's git handle."""

    def __init__(self, box: "SyncBox") -> None:
        self._owner = box

    def status(self, path: str) -> Any:
        """Structured ``GitStatus`` of the repository at ``path``."""
        return self._owner._sync(self._owner._box.git.status(path))

    def branches(self, path: str) -> Any:
        """``GitBranches`` of the repository at ``path``."""
        return self._owner._sync(self._owner._box.git.branches(path))
