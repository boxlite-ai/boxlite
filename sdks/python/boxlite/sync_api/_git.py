"""SyncGitHandle - synchronous git operations for a box."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._box import SyncBox

__all__ = ["SyncGitHandle"]


class SyncGitHandle:
    """Synchronous wrapper for a box's git handle."""

    def __init__(self, box: "SyncBox") -> None:
        self._owner = box

    def configure_user(
        self,
        name: str,
        email: str,
        scope: str | None = None,
        path: str | None = None,
    ) -> None:
        """Set `user.name` and `user.email` for commits in this box."""
        self._owner._sync(self._owner._box.git.configure_user(name, email, scope, path))

    def set_config(
        self,
        key: str,
        value: str,
        scope: str | None = None,
        path: str | None = None,
    ) -> None:
        """Write a git config value."""
        self._owner._sync(self._owner._box.git.set_config(key, value, scope, path))

    def get_config(
        self,
        key: str,
        scope: str | None = None,
        path: str | None = None,
    ) -> str:
        """Read a git config value."""
        return self._owner._sync(self._owner._box.git.get_config(key, scope, path))
