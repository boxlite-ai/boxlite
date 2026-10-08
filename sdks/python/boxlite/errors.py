"""
BoxLite error types.

Provides a hierarchy of exceptions for different failure modes.
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
    "ResourceExhaustedError",
    "SessionReapedError",
    "StoppedError",
    "StorageError",
    "TimeoutError",
    "UnsupportedError",
    "UpstreamUnavailableError",
]


class BoxliteError(Exception):
    """Base exception for all boxlite errors."""


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


class _NativeError(BoxliteError, RuntimeError):
    """
    A failure the native runtime reported.

    Each subclass is one class of `BoxliteError::http()`
    (src/shared/src/errors.rs), named as it names it, and `code` is the
    machine code it gives — the same one a REST server answers with. Also a
    `RuntimeError`, because that is what every native failure was raised as
    before these classes existed.
    """

    code: str


class InvalidArgumentError(_NativeError):
    """The caller passed a value the runtime refuses."""

    code = "invalid_argument"


class UnsupportedError(_NativeError):
    """The operation is not available on this runtime or backend."""

    code = "unsupported"


class NotFoundError(_NativeError):
    """The box, image, volume or other resource named does not exist."""

    code = "not_found"


class SessionReapedError(_NativeError):
    """The session this call belonged to has been reaped."""

    code = "session_reaped"


class AlreadyExistsError(_NativeError):
    """A resource with that name or id already exists."""

    code = "already_exists"


class InvalidStateError(_NativeError):
    """The resource is in a state that does not allow the operation."""

    code = "invalid_state"


class StoppedError(_NativeError):
    """The box has stopped."""

    code = "stopped"


class ImageError(_NativeError):
    """An image could not be pulled or read."""

    code = "image_pull_failed"


class ExecutionError(_NativeError):
    """A process inside the box could not be run."""

    code = "execution_failed"


class ResourceExhaustedError(_NativeError):
    """A limit was reached; retrying later may succeed."""

    code = "resource_exhausted"


class NetworkError(_NativeError):
    """The network was unavailable."""

    code = "network_unavailable"


class UpstreamUnavailableError(_NativeError):
    """A component the runtime depends on did not answer."""

    code = "upstream_unavailable"


class EngineError(_NativeError):
    """The virtualization engine reported a failure."""

    code = "engine_unavailable"


class StorageError(_NativeError):
    """Reading or writing the runtime's storage failed."""

    code = "storage_error"


class DatabaseError(_NativeError):
    """The runtime's database failed."""

    code = "database_error"


class MetadataError(_NativeError):
    """Stored metadata could not be read or written."""

    code = "metadata_error"


class ConfigError(_NativeError):
    """The runtime's configuration is invalid, or authentication failed."""

    code = "config_error"


class InternalError(_NativeError):
    """An unexpected failure inside the runtime."""

    code = "internal"
