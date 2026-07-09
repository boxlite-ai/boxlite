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
        error_message: Diagnostic message when process died unexpectedly
            (e.g., container init death). None if normal exit.
    """

    exit_code: int
    stdout: str
    stderr: str
    error_message: str | None = None


def _looks_like_command_start_error(message: str) -> bool:
    """Return true for errors caused by an invalid user command."""
    lowered = message.lower()
    return (
        ("executable" in lowered and "not found" in lowered)
        or "not found in $path" in lowered
        or "not found in path" in lowered
        or "does not have correct permissions" in lowered
        or "permission denied" in lowered
    )


def _looks_like_timeout_result(
    exit_code: int,
    *,
    timeout: float | None,
    elapsed: float,
) -> bool:
    if timeout is None:
        return False
    if exit_code not in {-15, -9}:
        return False
    return elapsed >= max(0.0, timeout * 0.8)
