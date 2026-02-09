"""
SyncBox - Synchronous wrapper for Box.

Mirrors the native Box API exactly, but with synchronous methods.
"""

from typing import TYPE_CHECKING, List, Optional, Tuple

if TYPE_CHECKING:
    from ._boxlite import SyncBoxlite
    from ._execution import SyncExecution
    from ..boxlite import Box, BoxInfo, BoxMetrics

__all__ = ["SyncBox"]


class SyncBox:
    """
    Synchronous wrapper for Box.

    Provides the same API as the native Box class, but with synchronous methods.
    Uses greenlet fiber switching internally to bridge async operations.

    Usage:
        with SyncBoxlite.default() as runtime:
            box = runtime.create(BoxOptions(image="alpine:latest"))

            execution = box.exec("echo", ["Hello"])
            stdout = execution.stdout()

            for line in stdout:
                print(line)

            result = execution.wait()
            box.stop()
    """

    def __init__(
        self,
        runtime: "SyncBoxlite",
        box: "Box",
    ) -> None:
        """
        Create a SyncBox wrapper.

        Args:
            runtime: The SyncBoxlite runtime providing event loop and dispatcher
            box: The native Box object to wrap
        """
        from ._sync_base import SyncBase

        self._box = box
        self._runtime = runtime
        # Create a SyncBase helper for _sync() method
        self._sync_helper = SyncBase(box, runtime.loop, runtime.dispatcher_fiber)

    def _sync(self, coro):
        """Run async operation synchronously."""
        return self._sync_helper._sync(coro)

    @property
    def id(self) -> str:
        """Get the box ID."""
        return self._box.id

    @property
    def name(self) -> Optional[str]:
        """Get the box name (if set)."""
        return self._box.name

    def info(self) -> "BoxInfo":
        """Get box information (synchronous, no I/O)."""
        return self._box.info()

    def start(self) -> None:
        """
        Start the box (initialize VM).

        For Configured boxes: initializes VM for the first time.
        For Stopped boxes: restarts the VM.

        This is idempotent - calling start() on a Running box is a no-op.
        Also called implicitly by exec() if the box is not running.
        """
        self._sync(self._box.start())

    def exec(
        self,
        cmd: str,
        args: Optional[List[str]] = None,
        env: Optional[List[Tuple[str, str]]] = None,
        tty: bool = False,
    ) -> "SyncExecution":
        """
        Execute a command in the box.

        Args:
            cmd: Command to run (e.g., "echo", "python")
            args: Command arguments as list
            env: Environment variables as list of (key, value) tuples
            tty: Enable TTY mode for interactive sessions

        Returns:
            SyncExecution handle for streaming output and waiting for completion.

        Example:
            execution = box.exec("echo", ["Hello, World!"])
            for line in execution.stdout():
                print(line)
            result = execution.wait()
            print(f"Exit code: {result.exit_code}")
        """
        from ._execution import SyncExecution

        # Run the async exec and get the Execution handle
        execution = self._sync(self._box.exec(cmd, args, env, tty))
        return SyncExecution(self._runtime, execution)

    def stop(self) -> None:
        """Stop the box (preserves state for potential restart)."""
        self._sync(self._box.stop())

    def metrics(self) -> "BoxMetrics":
        """Get box metrics (CPU, memory usage, etc.)."""
        return self._sync(self._box.metrics())

    # Context manager support
    def __enter__(self) -> "SyncBox":
        """Enter context - starts the box."""
        self._sync(self._box.__aenter__())
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Exit context - stops the box."""
        self._sync(self._box.__aexit__(exc_type, exc_val, exc_tb))
