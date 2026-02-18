"""
SyncExecution - Synchronous wrapper for Execution.

Mirrors the native Execution API exactly, but with synchronous methods.
"""

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ._boxlite import SyncBoxlite
    from ..boxlite import Execution

__all__ = ["SyncExecution", "SyncExecStdin", "SyncExecStdout", "SyncExecStderr"]


class SyncExecStdin:
    """
    Synchronous wrapper for execution stdin.

    Usage:
        stdin = execution.stdin()
        stdin.send_input(b"hello\\n")
        stdin.close()
    """

    def __init__(self, ctx: "SyncBoxlite", async_stdin) -> None:
        self._ctx = ctx
        self._async_stdin = async_stdin

        from ._sync_base import SyncBase

        self._sync_helper = SyncBase(async_stdin, ctx.loop, ctx.dispatcher_fiber)

    def _sync(self, coro):
        """Run async operation synchronously."""
        return self._sync_helper._sync(coro)

    def send_input(self, data: bytes) -> None:
        """Write data to stdin."""
        self._sync(self._async_stdin.send_input(data))

    def close(self) -> None:
        """Close stdin stream, signaling EOF to the process."""
        self._sync(self._async_stdin.close())


class SyncExecStdout:
    """
    Synchronous iterator for execution stdout.

    Mirrors ExecStdout but uses regular iteration instead of async iteration.

    Usage:
        stdout = execution.stdout()
        for line in stdout:
            print(line)
    """

    def __init__(self, ctx: "SyncBoxlite", async_stdout) -> None:
        self._ctx = ctx
        self._async_stdout = async_stdout
        self._async_iter = None

        from ._sync_base import SyncBase

        self._sync_helper = SyncBase(async_stdout, ctx.loop, ctx.dispatcher_fiber)

    def _sync(self, coro):
        """Run async operation synchronously."""
        return self._sync_helper._sync(coro)

    def __iter__(self) -> "SyncExecStdout":
        """Start iteration."""
        self._async_iter = self._async_stdout.__aiter__()
        return self

    def __next__(self) -> str:
        """Get next line from stdout."""
        if self._async_iter is None:
            self._async_iter = self._async_stdout.__aiter__()

        try:
            line = self._sync(self._async_iter.__anext__())
            # Decode bytes to string if needed
            if isinstance(line, bytes):
                return line.decode("utf-8", errors="replace")
            return line
        except StopAsyncIteration:
            raise StopIteration


class SyncExecStderr:
    """
    Synchronous iterator for execution stderr.

    Mirrors ExecStderr but uses regular iteration instead of async iteration.

    Usage:
        stderr = execution.stderr()
        for line in stderr:
            print(line)
    """

    def __init__(self, ctx: "SyncBoxlite", async_stderr) -> None:
        self._ctx = ctx
        self._async_stderr = async_stderr
        self._async_iter = None

        from ._sync_base import SyncBase

        self._sync_helper = SyncBase(async_stderr, ctx.loop, ctx.dispatcher_fiber)

    def _sync(self, coro):
        """Run async operation synchronously."""
        return self._sync_helper._sync(coro)

    def __iter__(self) -> "SyncExecStderr":
        """Start iteration."""
        self._async_iter = self._async_stderr.__aiter__()
        return self

    def __next__(self) -> str:
        """Get next line from stderr."""
        if self._async_iter is None:
            self._async_iter = self._async_stderr.__aiter__()

        try:
            line = self._sync(self._async_iter.__anext__())
            # Decode bytes to string if needed
            if isinstance(line, bytes):
                return line.decode("utf-8", errors="replace")
            return line
        except StopAsyncIteration:
            raise StopIteration


class SyncExecution:
    """
    Synchronous wrapper for Execution.

    Provides the same API as the native Execution class, but with synchronous methods.
    stdout() and stderr() return sync iterables instead of async iterables.

    Usage:
        execution = box.exec("echo", ["Hello"])

        # Stream stdout
        for line in execution.stdout():
            print(f"stdout: {line}")

        # Stream stderr
        for line in execution.stderr():
            print(f"stderr: {line}")

        # Wait for completion
        result = execution.wait()
        print(f"Exit code: {result.exit_code}")
    """

    def __init__(
        self,
        ctx: "SyncBoxlite",
        execution: "Execution",
    ) -> None:
        """
        Create a SyncExecution wrapper.

        Args:
            ctx: The SyncBoxlite providing event loop and dispatcher
            execution: The native Execution object to wrap
        """
        from ._sync_base import SyncBase

        self._execution = execution
        self._ctx = ctx
        self._sync_helper = SyncBase(execution, ctx.loop, ctx.dispatcher_fiber)

    def _sync(self, coro):
        """Run async operation synchronously."""
        return self._sync_helper._sync(coro)

    @property
    def id(self) -> str:
        """Get the execution ID."""
        return self._execution.id

    def stdin(self) -> Optional[SyncExecStdin]:
        """
        Get synchronous stdin writer.

        Returns:
            SyncExecStdin writer, or None if stdin is not available.

        Usage:
            stdin = execution.stdin()
            if stdin:
                stdin.send_input(b"hello\\n")
                stdin.close()
        """
        async_stdin = self._execution.stdin()
        if async_stdin is None:
            return None
        return SyncExecStdin(self._ctx, async_stdin)

    def stdout(self) -> Optional[SyncExecStdout]:
        """
        Get synchronous stdout iterator.

        Returns:
            SyncExecStdout iterator, or None if stdout is not available.

        Usage:
            stdout = execution.stdout()
            if stdout:
                for line in stdout:
                    print(line)
        """
        async_stdout = self._execution.stdout()
        if async_stdout is None:
            return None
        return SyncExecStdout(self._ctx, async_stdout)

    def stderr(self) -> Optional[SyncExecStderr]:
        """
        Get synchronous stderr iterator.

        Returns:
            SyncExecStderr iterator, or None if stderr is not available.

        Usage:
            stderr = execution.stderr()
            if stderr:
                for line in stderr:
                    print(line)
        """
        async_stderr = self._execution.stderr()
        if async_stderr is None:
            return None
        return SyncExecStderr(self._ctx, async_stderr)

    def wait(self):
        """
        Wait for execution to complete.

        Returns:
            ExecResult with exit_code and other completion info.
        """
        return self._sync(self._execution.wait())

    def kill(self) -> None:
        """Kill the running execution."""
        self._sync(self._execution.kill())

    def resize_tty(self, rows: int, cols: int) -> None:
        """
        Resize PTY terminal window.

        Only works for executions started with TTY enabled (tty=True in exec()).

        Args:
            rows: Number of rows (height) for the terminal.
            cols: Number of columns (width) for the terminal.
        """
        self._sync(self._execution.resize_tty(rows, cols))
