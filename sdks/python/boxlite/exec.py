"""
Execution API - Simple interface for command execution.

Provides Docker-like API for executing commands in boxes.
"""

from dataclasses import dataclass

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
        timed_out: True if the configured execution timeout terminated the command.
        error_message: Diagnostic message when process died unexpectedly
            (e.g., container init death). None if normal exit.
    """

    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False
    error_message: str | None = None
