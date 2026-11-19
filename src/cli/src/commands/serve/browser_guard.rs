//! Refuses requests a browser can be tricked into sending to a local server.
//!
//! Two attacks reach `boxlite serve` from an ordinary web page:
//!
//! - **DNS rebinding.** A page on `evil.example` re-resolves its own name to
//!   127.0.0.1 and becomes same-origin with the API. The request still names
//!   `evil.example` in its `Host` header, so a loopback-bound server accepts
//!   only loopback names there.
//! - **Cross-site requests.** Browsers send simple POSTs and every WebSocket
//!   upgrade without a CORS preflight. They always label such a request with
//!   its `Origin`, so the guard requires that origin to be this server.
//!
//! Non-browser clients (the SDKs, the CLI, curl) send no `Origin` and a
//! loopback `Host`, so they pass unchanged.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;

use super::{error_response, is_loopback_host};

/// Host names a loopback-bound server answers to without configuration.
const LOOPBACK_NAMES: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// Decides whether a request may reach the API. Built once from the bind
/// address and `--allowed-host`, then shared by every request.
pub(super) struct BrowserGuard {
    /// Lower-case host names the `Host` header may carry. `None` when the
    /// server is bound beyond loopback: a rebound name cannot reach it any more
    /// easily than a real one, and the API key guards it instead.
    allowed_hosts: Option<Vec<String>>,
}

impl BrowserGuard {
    /// `extra_hosts` may be written with or without a port; only the name
    /// is compared. The bind address itself is always accepted, so
    /// `--host 127.0.0.2` answers to `127.0.0.2`.
    pub(super) fn new(bind_host: &str, extra_hosts: &[String]) -> Self {
        let allowed_hosts = is_loopback_host(bind_host).then(|| {
            LOOPBACK_NAMES
                .iter()
                .copied()
                .chain(std::iter::once(bind_host))
                .chain(extra_hosts.iter().map(|host| host_name(host)))
                .map(normalize_host)
                .collect()
        });
        Self { allowed_hosts }
    }

    /// Axum middleware: 403 for a refused request, otherwise pass it on.
    pub(super) async fn enforce(
        State(guard): State<Arc<BrowserGuard>>,
        req: Request,
        next: Next,
    ) -> Response {
        match guard.check(req.headers()) {
            Ok(()) => next.run(req).await,
            Err(reason) => error_response(StatusCode::FORBIDDEN, reason, "AuthError", "forbidden"),
        }
    }

    fn check(&self, headers: &HeaderMap) -> Result<(), &'static str> {
        let host = headers.get(HOST).and_then(|value| value.to_str().ok());
        if let (Some(allowed), Some(host)) = (&self.allowed_hosts, host)
            && !allowed.contains(&normalize_host(host_name(host)))
        {
            return Err("request Host is not a name of this server");
        }
        let Some(origin) = headers.get(ORIGIN) else {
            return Ok(());
        };
        let same_origin = match (origin.to_str().ok().and_then(origin_authority), host) {
            (Some(origin), Some(host)) => origin.eq_ignore_ascii_case(host),
            _ => false,
        };
        if same_origin {
            Ok(())
        } else {
            Err("request Origin is not this server")
        }
    }
}

/// The host part of a `Host` header value: `[::1]:8100` -> `[::1]`,
/// `localhost:8100` -> `localhost`.
fn host_name(host: &str) -> &str {
    if host.starts_with('[') {
        return host.split_inclusive(']').next().unwrap_or(host);
    }
    host.rsplit_once(':').map_or(host, |(name, _port)| name)
}

/// Lower-case and drop IPv6 brackets, so `[::1]` and `::1` compare equal.
fn normalize_host(host: &str) -> String {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

/// `host:port` of a serialized origin such as `http://127.0.0.1:8100`.
/// `null` and anything without an `http(s)` scheme yield `None`.
fn origin_authority(origin: &str) -> Option<&str> {
    origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(host: Option<&str>, origin: Option<&str>) -> HeaderMap {
        let mut map = HeaderMap::new();
        if let Some(host) = host {
            map.insert(HOST, HeaderValue::from_str(host).unwrap());
        }
        if let Some(origin) = origin {
            map.insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        map
    }

    #[test]
    fn loopback_bind_accepts_each_loopback_name() {
        let guard = BrowserGuard::new("127.0.0.1", &[]);
        for host in [
            "127.0.0.1:8100",
            "localhost:8100",
            "LOCALHOST",
            "[::1]:8100",
            "[::1]",
        ] {
            assert_eq!(guard.check(&headers(Some(host), None)), Ok(()), "{host}");
        }
    }

    #[test]
    fn loopback_bind_refuses_a_rebound_name() {
        let guard = BrowserGuard::new("127.0.0.1", &[]);
        for host in [
            "evil.example:8100",
            "evil.example",
            "127.0.0.1.evil.example",
            "[::2]:8100",
        ] {
            assert!(guard.check(&headers(Some(host), None)).is_err(), "{host}");
        }
    }

    #[test]
    fn allowed_host_extends_the_loopback_names() {
        let guard = BrowserGuard::new("localhost", &["Box.Internal".to_string()]);
        assert_eq!(
            guard.check(&headers(Some("box.internal:8100"), None)),
            Ok(())
        );
        assert!(guard.check(&headers(Some("other.internal"), None)).is_err());
    }

    #[test]
    fn allowed_host_written_with_a_port_still_matches() {
        let guard = BrowserGuard::new("127.0.0.1", &["box.internal:8100".to_string()]);
        assert_eq!(
            guard.check(&headers(Some("box.internal:8100"), None)),
            Ok(())
        );
    }

    #[test]
    fn loopback_bind_accepts_its_own_address() {
        let guard = BrowserGuard::new("127.0.0.2", &[]);
        assert_eq!(guard.check(&headers(Some("127.0.0.2:8100"), None)), Ok(()));
    }

    #[test]
    fn network_bind_skips_the_host_check() {
        let guard = BrowserGuard::new("0.0.0.0", &[]);
        assert_eq!(guard.check(&headers(Some("server.lan:8100"), None)), Ok(()));
    }

    #[test]
    fn origin_must_equal_the_requested_host() {
        let guard = BrowserGuard::new("127.0.0.1", &[]);
        let host = Some("127.0.0.1:8100");
        assert_eq!(
            guard.check(&headers(host, Some("http://127.0.0.1:8100"))),
            Ok(())
        );
        for origin in [
            "http://evil.example",
            "http://127.0.0.1:3000",
            "http://localhost:8100",
            "null",
        ] {
            assert!(
                guard.check(&headers(host, Some(origin))).is_err(),
                "{origin}"
            );
        }
    }

    #[test]
    fn origin_without_host_is_refused() {
        let guard = BrowserGuard::new("0.0.0.0", &[]);
        assert!(
            guard
                .check(&headers(None, Some("http://server.lan")))
                .is_err()
        );
    }

    #[test]
    fn client_without_origin_or_host_passes() {
        let guard = BrowserGuard::new("127.0.0.1", &[]);
        assert_eq!(guard.check(&headers(None, None)), Ok(()));
    }
}
