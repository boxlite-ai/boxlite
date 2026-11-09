"""
SyncExecutions - Synchronous wrapper for the live execution namespace.

The owning box is resolved on every call, so a ``SyncSimpleBox`` that has not
entered its context yet neither creates nor starts anything.
"""

from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..boxlite import ExecutionInfo
    from ._box import SyncBox
    from ._execution import SyncExecution

__all__ = ["SyncExecutions"]


class SyncExecutions:
    """
    Synchronous live-execution namespace for one box.

    Usage:
        with SyncSimpleBox(image="alpine:latest") as box:
            for info in box.executions().list():
                print(info.execution_id)

            control = box.executions().get(execution_id)
            control.kill()
    """

    def __init__(self, owner: "Callable[[], SyncBox | None]") -> None:
        """
        Create a namespace bound to the box that owns it.

        Args:
            owner: Resolves the owning SyncBox, or None before it is created
        """
        self._owner = owner

    def _box(self) -> "SyncBox | None":
        return self._owner()

    def list(self) -> "list[ExecutionInfo]":
        """List live guest executions without creating or starting a box."""
        owner = self._box()
        if owner is None:
            return []
        return owner._sync(owner._box.executions().list())

    def get(self, execution_id: str) -> "SyncExecution":
        """Recover control without claiming the session's output reader.

        The handle's stream accessors raise RuntimeError because it has no streams.
        """
        from ._execution import SyncExecution

        owner = self._box()
        if owner is None:
            raise RuntimeError("Box not started. Use 'with SyncSimpleBox(...)' first.")
        return SyncExecution(
            owner._runtime, owner._sync(owner._box.executions().get(execution_id))
        )

    def attach(self, execution_id: str, *, stdin: bool = True) -> "SyncExecution":
        """Attach to a listed live session without starting the box."""
        from ._execution import SyncExecution

        owner = self._box()
        if owner is None:
            raise RuntimeError("Box not started. Use 'with SyncSimpleBox(...)' first.")
        return SyncExecution(
            owner._runtime,
            owner._sync(owner._box.executions().attach(execution_id, stdin=stdin)),
        )
