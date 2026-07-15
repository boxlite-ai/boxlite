"""
BoxLite error types.

Provides a hierarchy of exceptions for different failure modes.
"""

__all__ = ["BoxliteError", "ExecError", "TimeoutError", "ParseError"]


def _command_start_exit_code(message: str) -> int:
    """Translate a pre-exec spawn failure to the conventional shell code."""
    detail = message.casefold()
    not_found_markers = (
        "not found in $path",
        "no such file or directory",
        "os error 2",
    )
    return 127 if any(marker in detail for marker in not_found_markers) else 126


class BoxliteError(Exception):
    """Base exception for all boxlite errors."""

    pass


class ExecError(BoxliteError):
    """
    Raised when a command execution fails (non-zero exit code).

    Attributes:
        command: The command that failed
        exit_code: The non-zero exit code
        stderr: Standard error output from the command
    """

    def __init__(self, command: str, exit_code: int, stderr: str):
        self.command = command
        self.exit_code = exit_code
        self.stderr = stderr
        super().__init__(
            f"Command '{command}' failed with exit code {exit_code}: {stderr}"
        )


class TimeoutError(BoxliteError):
    """Raised when an operation times out."""

    pass


class ParseError(BoxliteError):
    """Raised when output parsing fails."""

    pass
