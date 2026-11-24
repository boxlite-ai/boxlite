"""
Execution API - Simple interface for command execution.

Provides Docker-like API for executing commands in boxes.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .boxlite import Execution

__all__ = [
    "ExecResult",
]


@dataclass
class ExecResult:
    """
    Result from a command execution.

    Attributes:
        exit_code: Exit code from the command (negative if terminated by signal)
        stdout: Standard output as string
        stderr: Standard error as string
        error_message: Diagnostic message when process died unexpectedly
            (e.g., container init death). None if normal exit.
    """

    exit_code: int
    stdout: str
    stderr: str
    error_message: str | None = None


async def _close_exec_stdin(execution: "Execution") -> None:
    try:
        stdin = execution.stdin()
    except RuntimeError:
        # The native binding raises when the execution has no stdin stream.
        return
    await stdin.close()
