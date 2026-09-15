"""
BoxLite error types.

Errors raised by the native runtime map one-to-one onto the Rust
``BoxliteError`` variants, so callers can catch a specific failure
(``except NotFoundError``) instead of matching message text. Every class
derives from ``BoxliteError``.
"""

__all__ = [
    "AlreadyExistsError",
    "BoxliteError",
    "ConfigError",
    "DatabaseError",
    "EngineError",
    "ExecError",
    "ExecutionError",
    "ImageError",
    "InternalError",
    "InvalidArgumentError",
    "InvalidStateError",
    "MetadataError",
    "NetworkError",
    "NotFoundError",
    "ParseError",
    "PortalError",
    "ResourceExhaustedError",
    "RpcError",
    "RpcTransportError",
    "SessionReapedError",
    "StoppedError",
    "StorageError",
    "TimeoutError",
    "UnsupportedEngineError",
    "UnsupportedError",
]


class BoxliteError(RuntimeError):
    """Base exception for all boxlite errors.

    Derives from ``RuntimeError`` because the native runtime raised plain
    ``RuntimeError`` before typed errors existed; existing
    ``except RuntimeError`` handlers keep working.
    """


# ── Raised by the native runtime (one per Rust BoxliteError variant) ──────


class EngineError(BoxliteError):
    """The VM engine reported an error."""


class UnsupportedEngineError(BoxliteError):
    """The requested VM engine is not supported on this host."""


class ConfigError(BoxliteError):
    """Invalid or incompatible configuration."""


class StorageError(BoxliteError):
    """A filesystem or disk operation failed."""


class ImageError(BoxliteError):
    """Pulling, resolving, or unpacking an image failed."""


class PortalError(BoxliteError):
    """Host-to-guest communication failed."""


class NetworkError(BoxliteError):
    """A networking operation failed."""


class RpcError(BoxliteError):
    """A gRPC call to the guest failed."""


class RpcTransportError(BoxliteError):
    """The gRPC transport to the guest failed."""


class InternalError(BoxliteError):
    """An unexpected internal error."""


class ExecutionError(BoxliteError):
    """The runtime could not run a command (for example, the program was not found).

    Distinct from ``ExecError``, which reports a command that ran and exited
    non-zero.
    """


class UnsupportedError(BoxliteError):
    """The operation is not supported."""


class NotFoundError(BoxliteError):
    """The box or resource does not exist."""


class AlreadyExistsError(BoxliteError):
    """The box or resource already exists."""


class InvalidStateError(BoxliteError):
    """The box is in the wrong state for the operation."""


class DatabaseError(BoxliteError):
    """A runtime database operation failed."""


class MetadataError(BoxliteError):
    """Stored metadata is corrupt or unreadable."""


class InvalidArgumentError(BoxliteError):
    """An argument was invalid."""


class StoppedError(BoxliteError):
    """The box or runtime has been stopped or shut down."""


class ResourceExhaustedError(BoxliteError):
    """A system resource limit was reached (disk full, no free VM slots)."""


class SessionReapedError(BoxliteError):
    """The interactive exec session was reaped after a disconnect; start a new exec."""


# ── Raised by the Python convenience wrappers ─────────────────────────────


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


class ParseError(BoxliteError):
    """Raised when output parsing fails."""
