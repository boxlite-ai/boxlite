//! Error types used across the Boxlite runtime.

use thiserror::Error;

/// Result type for Boxlite operations.
pub type BoxliteResult<T> = Result<T, BoxliteError>;

#[derive(Debug, Error)]
pub enum BoxliteError {
    #[error("unsupported engine kind")]
    UnsupportedEngine,

    #[error("engine reported an error: {0}")]
    Engine(String),

    #[error("configuration error: {0}")]
    Config(String),

    #[error("storage error: {0}")]
    Storage(String),

    #[error("images error: {0}")]
    Image(String),

    #[error("portal error: {0}")]
    Portal(String),

    #[error("network error: {0}")]
    Network(String),

    #[error("gRPC/tonic error: {0}")]
    Rpc(String),

    #[error("gRPC transport error: {0}")]
    RpcTransport(String),

    #[error("internal error: {0}")]
    Internal(String),

    #[error("Execution error: {0}")]
    Execution(String),

    #[error("unsupported: {0}")]
    Unsupported(String),

    /// Box not found in registry or database.
    #[error("box not found: {0}")]
    NotFound(String),

    /// Box or resource already exists.
    #[error("already exists: {0}")]
    AlreadyExists(String),

    /// Box is in wrong state for the requested operation.
    #[error("invalid state: {0}")]
    InvalidState(String),

    /// Database operation failed.
    #[error("database error: {0}")]
    Database(String),

    /// Metadata corruption or parsing error.
    #[error("metadata error: {0}")]
    MetadataError(String),

    /// Invalid argument provided.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    /// Resource (box or runtime) has been stopped/shutdown.
    #[error("stopped: {0}")]
    Stopped(String),

    /// System resource limit reached (e.g., VM address spaces exhausted).
    #[error("resource exhausted: {0}")]
    ResourceExhausted(String),

    /// An interactive execution session was reaped server-side after the
    /// client disconnected and did not reconnect within the grace window
    /// (default 5 min idle → SIGHUP, escalating to SIGKILL; 24h hard cap).
    /// Reattach via the same `execution_id` is no longer possible — start
    /// a new exec instead.
    #[error("session reaped: {0}")]
    SessionReaped(String),

    /// Operation exceeded its wall-clock deadline. Surfaced by the
    /// hang-defence wrappers (`box.create` total budget, lock
    /// acquisition timeout, …) instead of letting the caller block
    /// indefinitely on a wedged or crash-leaked counterparty.
    #[error("timed out: {0}")]
    Timeout(String),
}

// Implement From for common error types to enable `?` operator
impl From<std::io::Error> for BoxliteError {
    fn from(err: std::io::Error) -> Self {
        BoxliteError::Internal(format!("I/O error: {}", err))
    }
}

impl From<serde_json::Error> for BoxliteError {
    fn from(err: serde_json::Error) -> Self {
        BoxliteError::Internal(format!("JSON error: {}", err))
    }
}

impl From<String> for BoxliteError {
    fn from(err: String) -> Self {
        BoxliteError::Internal(err)
    }
}

impl From<&str> for BoxliteError {
    fn from(err: &str) -> Self {
        BoxliteError::Internal(err.to_string())
    }
}

impl From<tonic::Status> for BoxliteError {
    fn from(err: tonic::Status) -> Self {
        BoxliteError::Rpc(err.to_string())
    }
}

impl From<tonic::transport::Error> for BoxliteError {
    fn from(err: tonic::transport::Error) -> Self {
        BoxliteError::RpcTransport(err.to_string())
    }
}

/// Canonical mapping from a `BoxliteError` variant to its HTTP response
/// shape: `(status, error_type, code)` where:
///
/// - `status` is the HTTP status code as a `u16`. Callers convert to
///   their concrete `StatusCode` type (axum, reqwest, http) at the
///   boundary.
/// - `error_type` is the stable PascalCase identifier matching the
///   `error.type` field on the wire (K8s `Status.reason` style).
/// - `code` is the stable snake_case machine identifier matching the
///   `error.code` field on the wire (Stripe `code` style).
///
/// Both `error_type` and `code` are part of the public API contract;
/// changing them is a breaking change to SDK clients that pattern-match
/// on them. The single source of truth lives here so adding a
/// `BoxliteError` variant becomes a compile error elsewhere.
///
/// Mapping rationale per row:
/// - Status semantics follow RFC 9110 (§15.5 — 422 specifically) and
///   Google's `google.rpc.Code` ↔ HTTP translation, except
///   `FAILED_PRECONDITION` (Google → 400, boxlite → 409 per
///   Docker / K8s / Stripe public-API consensus).
/// - `Image` and `Execution` are 422 because the *shape* of the
///   request was valid; the semantic content (`alpine:lastest`,
///   `/nonexistent/binary`) was wrong — RFC 9110 §15.5.21.
/// - `Network`, `Portal`, `Rpc`, `RpcTransport`, `Engine` are 503
///   because they signal an internal dep is unavailable, not that the
///   server itself failed (gRPC `UNAVAILABLE`).
/// - `Storage`, `Database`, `MetadataError`, `Config`, `Internal` are
///   500 because they indicate a server-side bug or data-plane
///   corruption — not a recoverable condition.
impl BoxliteError {
    pub fn http(&self) -> (u16, &'static str, &'static str) {
        match self {
            BoxliteError::InvalidArgument(_) => (400, "InvalidArgumentError", "invalid_argument"),
            BoxliteError::Unsupported(_) | BoxliteError::UnsupportedEngine => {
                (400, "UnsupportedError", "unsupported")
            }
            BoxliteError::NotFound(_) => (404, "NotFoundError", "not_found"),
            BoxliteError::SessionReaped(_) => (410, "SessionReapedError", "session_reaped"),
            BoxliteError::AlreadyExists(_) => (409, "AlreadyExistsError", "already_exists"),
            BoxliteError::InvalidState(_) => (409, "InvalidStateError", "invalid_state"),
            BoxliteError::Stopped(_) => (409, "StoppedError", "stopped"),
            BoxliteError::Image(_) => (422, "ImageError", "image_pull_failed"),
            BoxliteError::Execution(_) => (422, "ExecutionError", "execution_failed"),
            BoxliteError::ResourceExhausted(_) => {
                (429, "ResourceExhaustedError", "resource_exhausted")
            }
            // 408 Request Timeout: caller waited longer than the
            // operation's wall-clock budget. Retryable in principle,
            // so we surface a distinct status rather than collapsing
            // onto 500.
            BoxliteError::Timeout(_) => (408, "TimeoutError", "timeout"),
            BoxliteError::Network(_) => (503, "NetworkError", "network_unavailable"),
            BoxliteError::Portal(_) | BoxliteError::Rpc(_) | BoxliteError::RpcTransport(_) => {
                (503, "UpstreamUnavailableError", "upstream_unavailable")
            }
            BoxliteError::Engine(_) => (503, "EngineError", "engine_unavailable"),
            BoxliteError::Storage(_) => (500, "StorageError", "storage_error"),
            BoxliteError::Database(_) => (500, "DatabaseError", "database_error"),
            BoxliteError::MetadataError(_) => (500, "MetadataError", "metadata_error"),
            BoxliteError::Config(_) => (500, "ConfigError", "config_error"),
            BoxliteError::Internal(_) => (500, "InternalError", "internal"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical `BoxliteError → (status, error_type, code)` table.
    ///
    /// Each row is asserted via [`BoxliteError::http`]. Adding a
    /// `BoxliteError` variant without extending this table OR the
    /// `http()` match will produce a compile error in the impl
    /// (exhaustive match) — the assertion here is the second wall:
    /// it pins the *exact* status / type / code so a silent re-map
    /// later (e.g. changing 422 → 400) trips the test.
    #[test]
    fn http_mapping_matches_canonical_table() {
        let cases: &[(BoxliteError, u16, &str, &str)] = &[
            (
                BoxliteError::InvalidArgument("cpus must be 1..32".into()),
                400,
                "InvalidArgumentError",
                "invalid_argument",
            ),
            (
                BoxliteError::Unsupported("feature x not built".into()),
                400,
                "UnsupportedError",
                "unsupported",
            ),
            (
                BoxliteError::UnsupportedEngine,
                400,
                "UnsupportedError",
                "unsupported",
            ),
            (
                BoxliteError::NotFound("box abc".into()),
                404,
                "NotFoundError",
                "not_found",
            ),
            (
                BoxliteError::SessionReaped("exec 123".into()),
                410,
                "SessionReapedError",
                "session_reaped",
            ),
            (
                BoxliteError::AlreadyExists("box abc".into()),
                409,
                "AlreadyExistsError",
                "already_exists",
            ),
            (
                BoxliteError::InvalidState("box not running".into()),
                409,
                "InvalidStateError",
                "invalid_state",
            ),
            (
                BoxliteError::Stopped("runtime shut down".into()),
                409,
                "StoppedError",
                "stopped",
            ),
            (
                BoxliteError::Image("manifest unknown for alpine:lastest".into()),
                422,
                "ImageError",
                "image_pull_failed",
            ),
            (
                BoxliteError::Execution("/nonexistent: no such file".into()),
                422,
                "ExecutionError",
                "execution_failed",
            ),
            (
                BoxliteError::ResourceExhausted("disk full".into()),
                429,
                "ResourceExhaustedError",
                "resource_exhausted",
            ),
            (
                BoxliteError::Timeout("box.create budget exceeded".into()),
                408,
                "TimeoutError",
                "timeout",
            ),
            (
                BoxliteError::Network("tap setup failed".into()),
                503,
                "NetworkError",
                "network_unavailable",
            ),
            (
                BoxliteError::Portal("portal not ready".into()),
                503,
                "UpstreamUnavailableError",
                "upstream_unavailable",
            ),
            (
                BoxliteError::Rpc("tonic status: …".into()),
                503,
                "UpstreamUnavailableError",
                "upstream_unavailable",
            ),
            (
                BoxliteError::RpcTransport("connection refused".into()),
                503,
                "UpstreamUnavailableError",
                "upstream_unavailable",
            ),
            (
                BoxliteError::Engine("krun init failed".into()),
                503,
                "EngineError",
                "engine_unavailable",
            ),
            (
                BoxliteError::Storage("qcow2 corrupt".into()),
                500,
                "StorageError",
                "storage_error",
            ),
            (
                BoxliteError::Database("sqlite locked".into()),
                500,
                "DatabaseError",
                "database_error",
            ),
            (
                BoxliteError::MetadataError("box.toml parse failed".into()),
                500,
                "MetadataError",
                "metadata_error",
            ),
            (
                BoxliteError::Config("startup misconfig".into()),
                500,
                "ConfigError",
                "config_error",
            ),
            (
                BoxliteError::Internal("unreachable".into()),
                500,
                "InternalError",
                "internal",
            ),
        ];

        for (err, want_status, want_type, want_code) in cases {
            let (status, etype, ecode) = err.http();
            assert_eq!(
                (status, etype, ecode),
                (*want_status, *want_type, *want_code),
                "variant {:?} mapped incorrectly",
                err
            );
        }
    }

    /// Spot-check: the snake_code identifier set is unique. Two
    /// variants sharing a code would break round-tripping on the
    /// client (which dispatches on `error.code`).
    #[test]
    fn http_code_strings_are_unique_per_logical_status() {
        // Variants that intentionally share a code (multi-variant
        // rows in the canonical table).
        let shared_ok: &[&str] = &["unsupported", "upstream_unavailable"];

        let all: Vec<&'static str> = [
            BoxliteError::InvalidArgument(String::new()),
            BoxliteError::Unsupported(String::new()),
            BoxliteError::UnsupportedEngine,
            BoxliteError::NotFound(String::new()),
            BoxliteError::SessionReaped(String::new()),
            BoxliteError::AlreadyExists(String::new()),
            BoxliteError::InvalidState(String::new()),
            BoxliteError::Stopped(String::new()),
            BoxliteError::Image(String::new()),
            BoxliteError::Execution(String::new()),
            BoxliteError::ResourceExhausted(String::new()),
            BoxliteError::Network(String::new()),
            BoxliteError::Portal(String::new()),
            BoxliteError::Rpc(String::new()),
            BoxliteError::RpcTransport(String::new()),
            BoxliteError::Engine(String::new()),
            BoxliteError::Storage(String::new()),
            BoxliteError::Database(String::new()),
            BoxliteError::MetadataError(String::new()),
            BoxliteError::Config(String::new()),
            BoxliteError::Internal(String::new()),
        ]
        .iter()
        .map(|e| e.http().2)
        .collect();

        // Build a histogram; codes seen >1 time must be in shared_ok.
        let mut counts: std::collections::HashMap<&'static str, usize> =
            std::collections::HashMap::new();
        for c in &all {
            *counts.entry(c).or_default() += 1;
        }
        for (code, n) in counts {
            if n > 1 {
                assert!(
                    shared_ok.contains(&code),
                    "code {:?} mapped by {} variants but not in shared_ok",
                    code,
                    n
                );
            }
        }
    }
}
