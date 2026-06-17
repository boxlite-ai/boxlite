//! HTTP error → BoxliteError mapping.
//!
//! Symmetric inverse of [`boxlite_shared::errors::BoxliteError::http`].
//! The server emits `(status, error.type, error.code)` per that table;
//! we dispatch on `error.code` (stable snake_case) to reconstruct the
//! `BoxliteError` variant. Falling back to status-only mapping when
//! the body is missing or doesn't parse.

use boxlite_shared::errors::BoxliteError;
use reqwest::StatusCode;

use super::types::ErrorModel;

/// Map a parsed structured error body to a `BoxliteError`.
///
/// Dispatch is on `body.code` (the stable snake string), making this
/// the symmetric inverse of `BoxliteError::http()`. Unknown codes fall
/// back on the HTTP status — keeps the client forward-compatible with
/// future server-side variants.
pub(crate) fn map_http_error(status: StatusCode, body: &ErrorModel) -> BoxliteError {
    let msg = body.message.clone();
    match body.code.as_str() {
        "invalid_argument" => BoxliteError::InvalidArgument(msg),
        "unsupported" => BoxliteError::Unsupported(msg),
        "unauthenticated" | "permission_denied" => BoxliteError::Config(format!("auth: {}", msg)),
        "not_found" => BoxliteError::NotFound(msg),
        "session_reaped" => BoxliteError::SessionReaped(msg),
        "already_exists" => BoxliteError::AlreadyExists(msg),
        "invalid_state" => BoxliteError::InvalidState(msg),
        "stopped" => BoxliteError::Stopped(msg),
        "image_pull_failed" => BoxliteError::Image(msg),
        "execution_failed" => BoxliteError::Execution(msg),
        "resource_exhausted" => BoxliteError::ResourceExhausted(msg),
        "network_unavailable" | "runner_non_json_error" => BoxliteError::Network(msg),
        "upstream_unavailable" => BoxliteError::Portal(msg),
        "engine_unavailable" => BoxliteError::Engine(msg),
        "storage_error" => BoxliteError::Storage(msg),
        "database_error" => BoxliteError::Database(msg),
        "metadata_error" => BoxliteError::MetadataError(msg),
        "config_error" => BoxliteError::Config(msg),
        "timeout" => BoxliteError::Internal(format!("server timed out: {}", msg)),
        "internal" => BoxliteError::Internal(msg),
        // Forward-compat: unknown code from a newer server — fall back
        // to status-driven mapping, preserving the body text.
        _ => map_http_status(status, &msg),
    }
}

/// Map a raw HTTP status to a `BoxliteError` when the body is missing
/// or not the envelope shape.
///
/// Distinguishes intermediary 5xx (proxy / unreachable upstream — we
/// emit the envelope for our own 5xx) by routing **502/503/504 with
/// no envelope** to `Network`, since the server we deployed never
/// produces a bare 5xx without our wire envelope.
pub(crate) fn map_http_status(status: StatusCode, text: &str) -> BoxliteError {
    match status.as_u16() {
        404 => BoxliteError::NotFound(text.to_string()),
        // Keep the `auth:` prefix (callers key on it) but state the actual
        // failure: 401 = credentials rejected (expired, or wrong credential
        // type for this endpoint — e.g. cloud exec's WS attach requires an API
        // key, not a browser/OIDC token); 403 = authenticated but not allowed
        // (often a stale org/path_prefix — `auth login` re-resolves it).
        401 => BoxliteError::Config(format!("auth: unauthorized (HTTP 401): {}", text)),
        403 => BoxliteError::Config(format!("auth: forbidden (HTTP 403): {}", text)),
        // Bare 5xx with no envelope ⇒ an intermediary spoke, not us.
        // The most common cause is a proxy / load balancer that
        // couldn't reach the destination (Clash returns 502 with
        // empty body for unresolvable hosts; ELB returns 504 on
        // upstream timeout).
        502..=504 => BoxliteError::Network(format!(
            "upstream returned HTTP {} (no error envelope; likely a \
             proxy or load balancer in front of the server). Body: {}",
            status,
            if text.is_empty() { "<empty>" } else { text }
        )),
        _ => BoxliteError::Internal(format!("HTTP {}: {}", status, text)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(msg: &str, etype: &str, code: &str) -> ErrorModel {
        ErrorModel {
            message: msg.to_string(),
            error_type: etype.to_string(),
            code: code.to_string(),
            request_id: None,
        }
    }

    /// One row of the round-trip table: `(http_status, error_type,
    /// snake_code, variant_predicate)`. Aliased so clippy doesn't
    /// flag the tuple as overly complex.
    type RoundTripRow = (u16, &'static str, &'static str, fn(&BoxliteError) -> bool);

    /// Canonical round-trip table — for every `(status, type, code)`
    /// the server can emit per `BoxliteError::http()`, the client must
    /// reconstruct a `BoxliteError` of the matching variant.
    ///
    /// Pinning the full table here is the second wall: even if the
    /// server-side mapping changes silently, this test fails — making
    /// the wire contract bilateral.
    #[test]
    fn round_trip_canonical_table() {
        let cases: &[RoundTripRow] = &[
            (400, "InvalidArgumentError", "invalid_argument", |e| {
                matches!(e, BoxliteError::InvalidArgument(_))
            }),
            (400, "UnsupportedError", "unsupported", |e| {
                matches!(e, BoxliteError::Unsupported(_))
            }),
            (401, "AuthError", "unauthenticated", |e| {
                matches!(e, BoxliteError::Config(_))
            }),
            (403, "AuthError", "permission_denied", |e| {
                matches!(e, BoxliteError::Config(_))
            }),
            (404, "NotFoundError", "not_found", |e| {
                matches!(e, BoxliteError::NotFound(_))
            }),
            (410, "SessionReapedError", "session_reaped", |e| {
                matches!(e, BoxliteError::SessionReaped(_))
            }),
            (409, "AlreadyExistsError", "already_exists", |e| {
                matches!(e, BoxliteError::AlreadyExists(_))
            }),
            (409, "InvalidStateError", "invalid_state", |e| {
                matches!(e, BoxliteError::InvalidState(_))
            }),
            (409, "StoppedError", "stopped", |e| {
                matches!(e, BoxliteError::Stopped(_))
            }),
            (422, "ImageError", "image_pull_failed", |e| {
                matches!(e, BoxliteError::Image(_))
            }),
            (422, "ExecutionError", "execution_failed", |e| {
                matches!(e, BoxliteError::Execution(_))
            }),
            (429, "ResourceExhaustedError", "resource_exhausted", |e| {
                matches!(e, BoxliteError::ResourceExhausted(_))
            }),
            (503, "NetworkError", "network_unavailable", |e| {
                matches!(e, BoxliteError::Network(_))
            }),
            (
                503,
                "UpstreamUnavailableError",
                "upstream_unavailable",
                |e| matches!(e, BoxliteError::Portal(_)),
            ),
            (503, "EngineError", "engine_unavailable", |e| {
                matches!(e, BoxliteError::Engine(_))
            }),
            (500, "StorageError", "storage_error", |e| {
                matches!(e, BoxliteError::Storage(_))
            }),
            (500, "DatabaseError", "database_error", |e| {
                matches!(e, BoxliteError::Database(_))
            }),
            (500, "MetadataError", "metadata_error", |e| {
                matches!(e, BoxliteError::MetadataError(_))
            }),
            (500, "ConfigError", "config_error", |e| {
                matches!(e, BoxliteError::Config(_))
            }),
            (500, "InternalError", "internal", |e| {
                matches!(e, BoxliteError::Internal(_))
            }),
            (504, "TimeoutError", "timeout", |e| {
                matches!(e, BoxliteError::Internal(_))
            }),
        ];

        for (status_u16, etype, code, predicate) in cases {
            let status = StatusCode::from_u16(*status_u16).expect("valid HTTP status");
            let err = map_http_error(status, &body("msg", etype, code));
            assert!(
                predicate(&err),
                "code {:?} (HTTP {}) mapped to unexpected variant: {:?}",
                code,
                status_u16,
                err
            );
        }
    }

    /// Unknown code from a newer server falls back to status-driven
    /// mapping — forward-compat. The body text must be preserved.
    #[test]
    fn unknown_code_falls_back_to_status_mapping() {
        let err = map_http_error(
            StatusCode::IM_A_TEAPOT,
            &body("can't brew", "TeapotError", "teapot_brewing_failed"),
        );
        match err {
            BoxliteError::Internal(s) => {
                assert!(s.contains("418"), "fallback should mention status: {s}");
                assert!(
                    s.contains("can't brew"),
                    "fallback should mention body: {s}"
                );
            }
            other => panic!("expected Internal fallback, got {other:?}"),
        }
    }

    /// Empty-body 502/503/504 ⇒ `Network`, not `Internal`. Pinned
    /// because this is precisely the symptom of the user-reported
    /// Clash proxy regression: the proxy returns 502 with no body
    /// for unresolvable destinations.
    #[test]
    fn bare_5xx_without_envelope_is_network_error() {
        for status_u16 in [502, 503, 504] {
            let status = StatusCode::from_u16(status_u16).unwrap();
            let err = map_http_status(status, "");
            assert!(
                matches!(err, BoxliteError::Network(_)),
                "HTTP {} with empty body should map to Network, got {:?}",
                status_u16,
                err
            );
        }
    }

    /// Bare 500 with no envelope is `Internal` (server-side bug, not
    /// proxy). Distinct from 502/503/504 so the CLI can render
    /// different remediation hints.
    #[test]
    fn bare_500_without_envelope_is_internal() {
        let err = map_http_status(StatusCode::INTERNAL_SERVER_ERROR, "");
        assert!(matches!(err, BoxliteError::Internal(_)));
    }

    /// 401/403 status-only still routes to `Config("auth: …")` so the
    /// CLI's auth-error classifier keeps working when the server
    /// somehow emits 401 without our envelope.
    #[test]
    fn bare_auth_status_routes_to_config() {
        let err = map_http_status(StatusCode::UNAUTHORIZED, "no token");
        assert!(matches!(err, BoxliteError::Config(_)));
        let err = map_http_status(StatusCode::FORBIDDEN, "wrong scope");
        assert!(matches!(err, BoxliteError::Config(_)));
    }

    /// 404 status-only is `NotFound` regardless of body shape.
    #[test]
    fn bare_404_is_not_found() {
        let err = map_http_status(StatusCode::NOT_FOUND, "");
        assert!(matches!(err, BoxliteError::NotFound(_)));
    }
}
