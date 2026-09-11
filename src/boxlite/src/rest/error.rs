//! HTTP error → BoxliteError mapping.
//!
//! Symmetric inverse of [`boxlite_shared::errors::BoxliteError::http`].
//!
//! `error.code` (stable snake_case) names the variant whenever this client
//! knows it. When the body names no code it knows, the HTTP status decides
//! instead — for the statuses the server answers codelessly, which is what
//! stops a refusal the caller caused from arriving as a server fault. What
//! the status table has no arm for stays `Internal`, and so does a 5xx whose
//! envelope named no code at all. A named code refines even a 5xx —
//! `network_unavailable` on a 503 is `Network`. An unknown code uses the
//! status baseline when one exists; otherwise it stays `Internal`.
//! See [`refine_by_status`] for why the omitted statuses are never guessed.

use boxlite_shared::errors::BoxliteError;
use reqwest::StatusCode;

use super::types::{ErrorModel, ErrorResponse, FlatErrorResponse};

/// Decode a failed response's body into the `BoxliteError` the server named.
///
/// The one place that knows the two envelope shapes and the bare-status
/// fallback. Callers that read the body themselves — the file-transfer routes,
/// which need the raw bytes on success — must come through here too, or a
/// refusal the server spelled out arrives as a server fault: a 500 for a 400
/// the caller caused, which is the whole reason the guest's own status codes
/// are preserved on the other backend.
pub(crate) fn map_http_body(status: StatusCode, text: &str) -> BoxliteError {
    if let Ok(err_resp) = serde_json::from_str::<ErrorResponse>(text) {
        map_enveloped(status, &err_resp.error)
    } else if let Ok(err_resp) = serde_json::from_str::<FlatErrorResponse>(text) {
        map_enveloped(status, &err_resp.into_error_model())
    } else {
        // A body that is not one of our envelopes may still carry a sentence
        // — the runner rejects with gin's `{"error": "<text>"}`. The class
        // stays status-derived either way; only the message improves.
        match envelope_message(text) {
            Some(sentence) => map_status(status, &sentence),
            None => map_status(status, text),
        }
    }
}

/// Shared by both envelope shapes: a recognized `code` names the variant,
/// otherwise the status does. Which fallback applies when neither knows the
/// status depends on what the body left out, and the two cases are not the
/// same failure.
fn map_enveloped(status: StatusCode, body: &ErrorModel) -> BoxliteError {
    let msg = body.message.clone();
    if let Some(err) = refine_by_code(&body.code, &msg) {
        return err;
    }
    if let Some(err) = refine_by_status(status, &msg) {
        return err;
    }
    if body.code.is_empty() {
        // The server named nothing beyond the status. A 5xx it stated itself
        // is its own fault to report — what the fabricated `internal` code
        // used to render — and never an intermediary's: the API answers
        // codelessly at 503 while under maintenance or missing object
        // storage, and calling that a proxy failure is this bug in mirror.
        return BoxliteError::Internal(msg);
    }
    // A code this client has not learned yet: the server named a class, this
    // client just cannot read it — but it did answer, so no intermediary is
    // implicated. The status baseline above already had its say.
    BoxliteError::Internal(msg)
}

/// The `code` → variant table. `None` means "this client does not know the
/// code" — including the empty string a body without the field decodes to —
/// and the caller keeps its status baseline.
fn refine_by_code(code: &str, msg: &str) -> Option<BoxliteError> {
    let msg = msg.to_string();
    Some(match code {
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
        _ => return None,
    })
}

/// The status baseline: the statuses this API answers with *codelessly*,
/// where the status alone fixes the class. 409 covers several server-side
/// variants (`already_exists` / `invalid_state` / `stopped`) so the baseline
/// takes the most general of them — only an explicit `code` singles out the
/// others.
///
/// A status the server only ever answers with a code attached gets no arm
/// (410 is always `session_reaped`; 422 always `image_pull_failed` or
/// `execution_failed`): inventing a baseline would hand callers a class no
/// server here states. 5xx is absent by the same rule — what an unavailable
/// server deserves is decided by its caller, not by this table.
fn refine_by_status(status: StatusCode, text: &str) -> Option<BoxliteError> {
    let msg = text.to_string();
    Some(match status.as_u16() {
        400 => BoxliteError::InvalidArgument(msg),
        // Keep the `auth:` prefix (callers key on it) but state the actual
        // failure: 401 = credentials rejected (expired, or wrong credential
        // type for this endpoint — e.g. cloud exec's WS attach requires an API
        // key, not a browser/OIDC token); 403 = authenticated but not allowed
        // (often a stale org/path_prefix — `auth login` re-resolves it).
        401 => BoxliteError::Config(format!("auth: unauthorized (HTTP 401): {}", text)),
        403 => BoxliteError::Config(format!("auth: forbidden (HTTP 403): {}", text)),
        404 => BoxliteError::NotFound(msg),
        // The API raises RequestTimeoutException while waiting on a volume, a
        // box state, or a resume — always without a code.
        408 => BoxliteError::Internal(format!("server timed out: {}", text)),
        409 => BoxliteError::InvalidState(msg),
        // 428 has no variant of its own; the API answers with it when a
        // runner or region is not in a state that permits the request.
        428 => BoxliteError::InvalidState(msg),
        429 => BoxliteError::ResourceExhausted(msg),
        _ => return None,
    })
}

/// The human sentence inside a body, whichever of our envelope shapes carries
/// it — for a caller that keeps status semantics of its own (the WS upgrade)
/// but must not surface raw JSON as the error text.
pub(crate) fn envelope_message(text: &str) -> Option<String> {
    /// gin's `{"error": "<text>"}` — the runner's rejection shape on its
    /// exec and attach routes. It names no class, only the sentence.
    #[derive(serde::Deserialize)]
    struct BareError {
        error: String,
    }

    if let Ok(resp) = serde_json::from_str::<ErrorResponse>(text) {
        return Some(resp.error.message);
    }
    if let Ok(resp) = serde_json::from_str::<FlatErrorResponse>(text) {
        return Some(resp.message);
    }
    serde_json::from_str::<BareError>(text)
        .ok()
        .map(|resp| resp.error)
}

/// A peer that answered with a status and a plain sentence rather than one of
/// our envelopes — the CONNECT tunnel handshake, which our own proxy answers
/// with 405 for the wrong method, 400 for a bad target, 403 for a box that is
/// not public, and 502 for a runner or visibility lookup it cannot reach.
///
/// It plainly answered, so nothing here may be attributed to an intermediary:
/// that is the misattribution the codeless-body path exists to remove, and a
/// 502 the proxy itself wrote is the same mistake one hop further out. The
/// peer's own sentence is carried through in every arm.
pub(crate) fn map_plain_reply(status: StatusCode, text: &str) -> BoxliteError {
    refine_by_status(status, text).unwrap_or_else(|| {
        if status.is_server_error() {
            // The peer could not reach what it needed on our behalf — the
            // proxy answers 502 for an unreachable runner. That is an
            // upstream availability failure, reported in the peer's words.
            BoxliteError::Network(text.to_string())
        } else {
            BoxliteError::Internal(format!("HTTP {}: {}", status, text))
        }
    })
}

/// Nothing decoded as one of our envelopes, so the status is all there is.
fn map_status(status: StatusCode, text: &str) -> BoxliteError {
    refine_by_status(status, text).unwrap_or_else(|| match status.as_u16() {
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
    })
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

    /// One row of the status-baseline table: `(http_status,
    /// variant_predicate, variant_name_for_the_failure_message)`.
    type BaselineRow = (u16, fn(&BoxliteError) -> bool, &'static str);

    /// Canonical round-trip table — for every `(status, type, code)`
    /// the server can emit per `BoxliteError::http()`, the client must
    /// reconstruct a `BoxliteError` of the matching variant.
    ///
    /// Pinning the full table here is the second wall: even if the
    /// server-side mapping changes silently, this test fails — making
    /// the wire contract bilateral. Each row is checked twice, because
    /// the status baseline would otherwise cover for a deleted `code`
    /// arm: once end-to-end through the envelope, once against the code
    /// table alone.
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
            let err = map_enveloped(status, &body("msg", etype, code));
            assert!(
                predicate(&err),
                "code {:?} (HTTP {}) mapped to unexpected variant: {:?}",
                code,
                status_u16,
                err
            );

            // The status baseline alone already yields the right variant for
            // most rows, so the assertion above would survive deleting the
            // row's `code` arm. Pin the code table separately, off any
            // status, so a dropped arm fails here.
            let refined = refine_by_code(code, "msg")
                .unwrap_or_else(|| panic!("code {:?} has no arm of its own", code));
            assert!(
                predicate(&refined),
                "code {:?} refined to unexpected variant: {:?}",
                code,
                refined
            );
        }
    }

    /// Forward-compat is the status floor doing its job: a newer server
    /// naming a code this client cannot read yet must degrade to the class
    /// the status states, never to `Internal` — a 400 is the caller's error
    /// whatever the server called it. Gating the baseline on "no code at
    /// all" would reintroduce the fabricated-`internal` bug for every code
    /// added after this client shipped.
    #[test]
    fn unknown_code_keeps_the_status_baseline() {
        let err = map_http_body(
            StatusCode::BAD_REQUEST,
            r#"{"statusCode":400,"error":"Bad Request","message":"cpus is negative","code":"future_error"}"#,
        );
        assert!(
            matches!(err, BoxliteError::InvalidArgument(_)),
            "unknown code on a 400 stays the caller's error: {err:?}"
        );
        assert!(err.to_string().contains("cpus is negative"), "{err:?}");

        let err = map_http_body(
            StatusCode::TOO_MANY_REQUESTS,
            r#"{"statusCode":429,"error":"Too Many Requests","message":"slow down","code":"quota_exceeded"}"#,
        );
        assert!(
            matches!(err, BoxliteError::ResourceExhausted(_)),
            "unknown code on a 429 stays resource exhaustion: {err:?}"
        );
    }

    /// Unknown code from a newer server: the baseline has its say, and past
    /// it the refusal stays the server's own fault — the server answered, so
    /// no intermediary is implicated. The body text must be preserved.
    #[test]
    fn unknown_code_stays_a_server_fault() {
        let err = map_enveloped(
            StatusCode::IM_A_TEAPOT,
            &body("can't brew", "TeapotError", "teapot_brewing_failed"),
        );
        match err {
            BoxliteError::Internal(s) => {
                assert!(
                    s.contains("can't brew"),
                    "the server's sentence must survive: {s}"
                );
            }
            other => panic!("expected Internal fallback, got {other:?}"),
        }

        // The forward-compat case the module header names: a newer server
        // adds a code on a 503. An older client must not blame the caller's
        // proxy for a failure the server stated itself.
        let err = map_enveloped(
            StatusCode::SERVICE_UNAVAILABLE,
            &body(
                "draining us-east-1",
                "RegionDrainingError",
                "region_draining",
            ),
        );
        assert!(
            matches!(err, BoxliteError::Internal(_)),
            "an unknown 503 code stays the server's own fault: {err:?}"
        );
        let rendered = err.to_string();
        assert!(
            rendered.contains("draining us-east-1"),
            "the server's sentence must survive: {rendered}"
        );
        assert!(
            !rendered.contains("proxy"),
            "an answered 503 must not be attributed to a proxy: {rendered}"
        );
    }

    /// Empty-body 502/503/504 ⇒ `Network`, not `Internal`. Pinned
    /// because this is precisely the symptom of the user-reported
    /// Clash proxy regression: the proxy returns 502 with no body
    /// for unresolvable destinations.
    #[test]
    fn bare_5xx_without_envelope_is_network_error() {
        for status_u16 in [502, 503, 504] {
            let status = StatusCode::from_u16(status_u16).unwrap();
            let err = map_status(status, "");
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
        let err = map_status(StatusCode::INTERNAL_SERVER_ERROR, "");
        assert!(matches!(err, BoxliteError::Internal(_)));
    }

    /// 401/403 status-only still routes to `Config("auth: …")` so the
    /// CLI's auth-error classifier keeps working when the server
    /// somehow emits 401 without our envelope.
    #[test]
    fn bare_auth_status_routes_to_config() {
        let err = map_status(StatusCode::UNAUTHORIZED, "no token");
        assert!(matches!(err, BoxliteError::Config(_)));
        let err = map_status(StatusCode::FORBIDDEN, "wrong scope");
        assert!(matches!(err, BoxliteError::Config(_)));
    }

    /// 404 status-only is `NotFound` regardless of body shape.
    #[test]
    fn bare_404_is_not_found() {
        let err = map_status(StatusCode::NOT_FOUND, "");
        assert!(matches!(err, BoxliteError::NotFound(_)));
    }

    /// The cloud API's NestJS filter emits `{path,timestamp,statusCode,
    /// error,message}` and omits `code` for every exception that does not
    /// set one itself. Such a body must be classified by its HTTP status —
    /// a refusal the caller caused stays a caller error. Reporting it as
    /// `Internal` blames the server for the client's own bad request.
    #[test]
    fn codeless_flat_body_is_classified_by_status() {
        let cases: &[BaselineRow] = &[
            (
                400,
                |e| matches!(e, BoxliteError::InvalidArgument(_)),
                "InvalidArgument",
            ),
            (404, |e| matches!(e, BoxliteError::NotFound(_)), "NotFound"),
            (
                409,
                |e| matches!(e, BoxliteError::InvalidState(_)),
                "InvalidState",
            ),
            // `Internal(_)` alone would also match the no-arm fallback;
            // the prefix is what proves the 408 arm answered.
            (
                408,
                |e| matches!(e, BoxliteError::Internal(m) if m.starts_with("server timed out:")),
                "Internal(server timed out)",
            ),
            (
                428,
                |e| matches!(e, BoxliteError::InvalidState(_)),
                "InvalidState",
            ),
            (
                429,
                |e| matches!(e, BoxliteError::ResourceExhausted(_)),
                "ResourceExhausted",
            ),
        ];
        for (status, is_expected, name) in cases {
            let text = format!(
                r#"{{"path":"/api/v1/org/boxes","timestamp":"2026-01-01T00:00:00.000Z","statusCode":{status},"error":"Whatever","message":"boom-{status}"}}"#
            );
            let err = map_http_body(StatusCode::from_u16(*status).unwrap(), &text);
            assert!(
                is_expected(&err),
                "codeless {status} should map to {name}, got {err:?}"
            );
            assert!(
                err.to_string().contains(&format!("boom-{status}")),
                "message must survive: {err:?}"
            );
        }
    }

    /// An explicit `code` still wins over the status baseline: the server
    /// naming `already_exists` on a 409 must not be flattened to the
    /// status-derived `InvalidState`.
    #[test]
    fn explicit_code_overrides_the_status_baseline() {
        let text =
            r#"{"statusCode":409,"error":"Conflict","message":"dup","code":"already_exists"}"#;
        let err = map_http_body(StatusCode::CONFLICT, text);
        assert!(matches!(err, BoxliteError::AlreadyExists(_)), "got {err:?}");
    }

    /// A nested envelope that names no code must still decode as an
    /// envelope, so the mapper classifies by status and carries the server's
    /// own sentence. While `ErrorModel::code` was a required field such a
    /// body failed to parse entirely and the caller was handed the raw JSON.
    #[test]
    fn nested_codeless_envelope_keeps_its_message() {
        // With `type`, without `code` — and the minimal shape carrying
        // neither: every field nothing dispatches on must be optional, or a
        // dead field decides whether the body decodes at all.
        let bodies = [
            r#"{"error":{"message":"cpu 200 exceeds the limit","type":"HttpError"}}"#,
            r#"{"error":{"message":"cpu 200 exceeds the limit"}}"#,
        ];
        for text in bodies {
            let err = map_http_body(StatusCode::BAD_REQUEST, text);

            assert!(
                matches!(err, BoxliteError::InvalidArgument(_)),
                "codeless 400 is a caller error: {err:?}"
            );
            let rendered = err.to_string();
            assert!(
                rendered.contains("cpu 200 exceeds the limit"),
                "server message must survive: {rendered}"
            );
            assert!(
                !rendered.contains('{'),
                "the raw body must not leak into the message: {rendered}"
            );
        }
    }

    /// The API answers codelessly at 503 too — under maintenance, or with
    /// object storage unconfigured. Such a body is the server stating its own
    /// fault, so it must not be re-attributed to a proxy: `Network` is what
    /// the CLI turns into "check your HTTP_PROXY", which is this bug in
    /// mirror. Only a body that decoded as nothing at all earns that.
    #[test]
    fn codeless_5xx_is_the_servers_own_fault_not_a_proxys() {
        let text = r#"{"statusCode":503,"error":"Service Unavailable","message":"Service is currently under maintenance"}"#;
        let err = map_http_body(StatusCode::SERVICE_UNAVAILABLE, text);

        assert!(
            matches!(err, BoxliteError::Internal(_)),
            "an answered 503 is not a transport failure: {err:?}"
        );
        let rendered = err.to_string();
        assert!(
            rendered.contains("under maintenance"),
            "server message must survive: {rendered}"
        );
        assert!(
            !rendered.contains("proxy"),
            "an answered 503 must not be attributed to a proxy: {rendered}"
        );
    }

    /// The statuses left out of the baseline on purpose. Each is one the
    /// server only ever answers with a code attached, so a codeless one has
    /// no producer and gets no guess — it stays `Internal` rather than
    /// inventing `SessionReaped` or `Execution` for a caller to branch on.
    /// Adding an arm for either is a wire-contract change, not a tidy-up.
    #[test]
    fn statuses_without_a_codeless_producer_get_no_baseline() {
        for status in [410u16, 422] {
            let text = format!(
                r#"{{"statusCode":{status},"error":"Whatever","message":"boom-{status}"}}"#
            );
            let err = map_http_body(StatusCode::from_u16(status).unwrap(), &text);
            assert!(
                matches!(err, BoxliteError::Internal(_)),
                "codeless {status} must not be given a baseline variant: {err:?}"
            );
            assert!(
                err.to_string().contains(&format!("boom-{status}")),
                "message must survive: {err:?}"
            );
        }
    }

    /// The runner's REST routes reject with gin's `{"error": "<text>"}` —
    /// not one of our envelopes. The class must still come from the status
    /// and the message must be the sentence, not the JSON that carried it.
    #[test]
    fn bare_gin_error_body_keeps_its_sentence() {
        let err = map_http_body(
            StatusCode::NOT_FOUND,
            r#"{"error":"execution e1 not found"}"#,
        );

        assert!(matches!(err, BoxliteError::NotFound(_)), "got {err:?}");
        let rendered = err.to_string();
        assert!(
            rendered.contains("execution e1 not found"),
            "the sentence must survive: {rendered}"
        );
        assert!(
            !rendered.contains('{'),
            "the raw body must not leak into the message: {rendered}"
        );
    }
}
