"""Error classification and the wire envelope for the reference server.

Split out of `server.py` so it can be exercised without the server's
third-party dependencies, the same reason `config.py` is a module of its own.

The Python SDK raises every runtime failure as a bare `RuntimeError` carrying
`BoxliteError`'s Display text, so the class has to be read back off the message
prefix. What each prefix maps to is `BoxliteError::http()`
(src/shared/src/errors.rs) — the same triple the CLI's `boxlite serve` and the
cloud runner answer from, so one failure is one class whichever server the
client talked to.
"""

from __future__ import annotations

# (BoxliteError Display prefix, HTTP status, error type, machine code).
#
# Ordered so no prefix shadows a longer one: `unsupported engine kind` does not
# start with `unsupported:`, so its row is reachable below that one.
ERROR_MAP = [
    ("box not found:", 404, "NotFoundError", "not_found"),
    ("already exists:", 409, "AlreadyExistsError", "already_exists"),
    ("invalid state:", 409, "InvalidStateError", "invalid_state"),
    ("stopped:", 409, "StoppedError", "stopped"),
    ("invalid argument:", 400, "InvalidArgumentError", "invalid_argument"),
    ("configuration error:", 500, "ConfigError", "config_error"),
    ("unsupported:", 400, "UnsupportedError", "unsupported"),
    ("unsupported engine", 400, "UnsupportedError", "unsupported"),
    ("images error:", 422, "ImageError", "image_pull_failed"),
    ("Execution error:", 422, "ExecutionError", "execution_failed"),
    ("resource exhausted:", 429, "ResourceExhaustedError", "resource_exhausted"),
    ("session reaped:", 410, "SessionReapedError", "session_reaped"),
    ("storage error:", 500, "StorageError", "storage_error"),
    ("internal error:", 500, "InternalError", "internal"),
    ("engine reported an error:", 503, "EngineError", "engine_unavailable"),
    ("portal error:", 503, "UpstreamUnavailableError", "upstream_unavailable"),
    ("network error:", 503, "NetworkError", "network_unavailable"),
    ("gRPC/tonic error:", 503, "UpstreamUnavailableError", "upstream_unavailable"),
    ("gRPC transport error:", 503, "UpstreamUnavailableError", "upstream_unavailable"),
    ("database error:", 500, "DatabaseError", "database_error"),
    ("metadata error:", 500, "MetadataError", "metadata_error"),
]

UNCLASSIFIED = (500, "InternalError", "internal")


def classify_error(message: str) -> tuple[int, str, str]:
    """The (status, type, code) triple a runtime failure crosses the wire as."""
    for prefix, status, error_type, code in ERROR_MAP:
        if message.startswith(prefix):
            return status, error_type, code
    return UNCLASSIFIED


def error_envelope(message: str, error_type: str, code: str) -> dict:
    """The error body `box.openapi.yaml` declares: `{error: {message, type, code}}`.

    `code` is the stable snake_case identifier, which is the only field clients
    dispatch on (`map_http_error`, src/boxlite/src/rest/error.rs). The HTTP
    status belongs in the status line and repeating it here left the body
    undecodable — the client then reads the status alone, and that fallback has
    no 400 arm, so a refusal this server states plainly arrived as a server
    fault.
    """
    return {"error": {"message": message, "type": error_type, "code": code}}
