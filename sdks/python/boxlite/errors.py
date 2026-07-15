"""
BoxLite error types.

Provides a hierarchy of exceptions for different failure modes.
"""

__all__ = ["BoxliteError", "ExecError", "TimeoutError", "ParseError"]


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
