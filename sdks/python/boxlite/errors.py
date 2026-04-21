"""
BoxLite error types.

Provides a hierarchy of exceptions matching the Rust BoxliteError variants.
"""

__all__ = [
    "BoxliteError",
    "EngineError",
    "ConfigError",
    "StorageError",
    "ImageError",
    "PortalError",
    "NetworkError",
    "RpcError",
    "InternalError",
    "ExecutionError",
    "NotFoundError",
    "AlreadyExistsError",
    "InvalidStateError",
    "DatabaseError",
    "InvalidArgumentError",
    "StoppedError",
    "ResourceExhaustedError",
    # Convenience aliases
    "ExecError",
    "TimeoutError",
    "ParseError",
]


class BoxliteError(Exception):
    """Base exception for all boxlite errors."""

    pass


# ── Mapped from Rust BoxliteError variants ───────────────────────────────


class EngineError(BoxliteError):
    """Raised when the VM engine reports an error."""

    pass


class ConfigError(BoxliteError):
    """Raised for configuration errors (invalid options, incompatible settings)."""

    pass


class StorageError(BoxliteError):
    """Raised when a filesystem or storage operation fails."""

    pass


class ImageError(BoxliteError):
    """Raised when image pull, resolution, or extraction fails."""

    pass


class PortalError(BoxliteError):
    """Raised when host-guest communication (gRPC portal) fails."""

    pass


class NetworkError(BoxliteError):
    """Raised when a networking operation fails."""

    pass


class RpcError(BoxliteError):
    """Raised when a gRPC or transport-level error occurs."""

    pass


class InternalError(BoxliteError):
    """Raised for unexpected internal errors."""

    pass


class ExecutionError(BoxliteError):
    """Raised when command execution fails at the runtime level."""

    pass


class NotFoundError(BoxliteError):
    """Raised when a box or resource is not found."""

    pass


class AlreadyExistsError(BoxliteError):
    """Raised when a box or resource already exists."""

    pass


class InvalidStateError(BoxliteError):
    """Raised when a box is in the wrong state for the requested operation."""

    pass


class DatabaseError(BoxliteError):
    """Raised when a database operation fails."""

    pass


class InvalidArgumentError(BoxliteError):
    """Raised when an invalid argument is provided."""

    pass


class StoppedError(BoxliteError):
    """Raised when operating on a stopped box or shutdown runtime."""

    pass


class ResourceExhaustedError(BoxliteError):
    """Raised when a system resource limit is reached (e.g., VM address spaces exhausted)."""

    pass


# ── Convenience exceptions (Python-side only) ────────────────────────────


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
