//! The browser console `serve` hosts at `/`.
//!
//! The page is static: files under `src/cli/web/` compiled into the binary.
//! It drives the same `/v1` API as the SDKs, so it needs no routes of its own
//! beyond the files and a sign-in endpoint.
//!
//! Sign-in only matters when `--api-key` is set. A browser cannot attach a
//! Bearer header to a WebSocket upgrade or a file download, so it trades the
//! key once for a session cookie (`HttpOnly`, `SameSite=Strict`) that the auth
//! middleware accepts in place of the header. Without a key the API is open
//! to this machine already, and the console opens directly.

use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, COOKIE, SET_COOKIE,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use super::{AppState, constant_time_eq, error_response};

/// Name of the cookie that carries a browser session id.
const SESSION_COOKIE: &str = "boxlite_session";

/// Same-origin scripts only. Styles allow `'unsafe-inline'` because the
/// terminal library writes its own `<style>` element at runtime.
const CONTENT_SECURITY: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; \
     img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/// Every file the console serves: (path under `/ui/`, media type, bytes).
const ASSETS: &[(&str, &str, &[u8])] = &[
    (
        "app.js",
        "text/javascript; charset=utf-8",
        include_bytes!("../../../web/app.js"),
    ),
    (
        "app.css",
        "text/css; charset=utf-8",
        include_bytes!("../../../web/app.css"),
    ),
    (
        "logo.svg",
        "image/svg+xml",
        include_bytes!("../../../web/logo.svg"),
    ),
    (
        "vendor/xterm/xterm.js",
        "text/javascript; charset=utf-8",
        include_bytes!("../../../web/vendor/xterm/xterm.js"),
    ),
    (
        "vendor/xterm/xterm.css",
        "text/css; charset=utf-8",
        include_bytes!("../../../web/vendor/xterm/xterm.css"),
    ),
    (
        "vendor/xterm/addon-fit.js",
        "text/javascript; charset=utf-8",
        include_bytes!("../../../web/vendor/xterm/addon-fit.js"),
    ),
];

const INDEX_HTML: &[u8] = include_bytes!("../../../web/index.html");

/// Session ids issued by sign-in. They live only in memory, so a restart
/// signs every browser out.
#[derive(Default)]
pub(super) struct BrowserSessions {
    ids: RwLock<HashSet<String>>,
}

impl BrowserSessions {
    /// Whether the request carries the cookie of a live session.
    pub(super) fn admits(&self, headers: &HeaderMap) -> bool {
        session_id(headers).is_some_and(|id| self.ids.read().unwrap().contains(id))
    }

    fn open(&self) -> String {
        // 32 random bytes from the OS generator, base64url-encoded.
        let id = openidconnect::CsrfToken::new_random_len(32)
            .secret()
            .clone();
        self.ids.write().unwrap().insert(id.clone());
        id
    }

    fn close(&self, headers: &HeaderMap) {
        if let Some(id) = session_id(headers) {
            self.ids.write().unwrap().remove(id);
        }
    }
}

/// Whether `path` belongs to the console rather than the API. The auth
/// middleware lets these through: the files hold no data, and sign-in is how
/// a browser gets credentials in the first place.
pub(super) fn is_console_path(path: &str) -> bool {
    path == "/" || path.starts_with("/ui/")
}

/// `GET /`
pub(super) async fn index() -> Response {
    asset_response("text/html; charset=utf-8", INDEX_HTML)
}

/// `GET /ui/{*file}`
pub(super) async fn asset(Path(file): Path<String>) -> Response {
    match ASSETS.iter().find(|(name, _, _)| *name == file) {
        Some((_, media_type, bytes)) => asset_response(media_type, bytes),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn asset_response(media_type: &str, bytes: &'static [u8]) -> Response {
    (
        [
            (CONTENT_TYPE, media_type),
            (CONTENT_SECURITY_POLICY, CONTENT_SECURITY),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (CACHE_CONTROL, "no-cache"),
        ],
        bytes,
    )
        .into_response()
}

#[derive(Serialize)]
pub(super) struct SessionStatus {
    /// The server has an API key, so the console must sign in.
    key_required: bool,
    /// This browser may call the API now.
    signed_in: bool,
}

/// `GET /ui/session`: what the page should show before calling the API.
pub(super) async fn session_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<SessionStatus> {
    let key_required = state.api_key.is_some();
    Json(SessionStatus {
        key_required,
        signed_in: !key_required || state.browser_sessions.admits(&headers),
    })
}

#[derive(Deserialize)]
pub(super) struct SignInRequest {
    token: String,
}

/// `POST /ui/session {"token": "<api key>"}`
pub(super) async fn sign_in(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SignInRequest>,
) -> Response {
    let Some(expected) = state.api_key.as_deref() else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if !constant_time_eq(req.token.as_bytes(), expected.as_bytes()) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "invalid token",
            "AuthError",
            "unauthenticated",
        );
    }
    let id = state.browser_sessions.open();
    let cookie = format!("{SESSION_COOKIE}={id}; HttpOnly; SameSite=Strict; Path=/");
    match HeaderValue::from_str(&cookie) {
        Ok(value) => (StatusCode::NO_CONTENT, [(SET_COOKIE, value)]).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `DELETE /ui/session`
pub(super) async fn sign_out(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    state.browser_sessions.close(&headers);
    let expired = format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    (
        StatusCode::NO_CONTENT,
        [(SET_COOKIE, HeaderValue::from_str(&expired).unwrap())],
    )
        .into_response()
}

/// The session id in the request's `Cookie` header, if any.
fn session_id(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == SESSION_COOKIE)
        .map(|(_, id)| id)
        .filter(|id| !id.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_cookie(cookie: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_str(cookie).unwrap());
        headers
    }

    #[test]
    fn session_admits_only_its_own_cookie() {
        let sessions = BrowserSessions::default();
        let id = sessions.open();
        assert!(sessions.admits(&with_cookie(&format!("theme=dark; {SESSION_COOKIE}={id}"))));
        assert!(!sessions.admits(&with_cookie(&format!("{SESSION_COOKIE}=forged"))));
        assert!(!sessions.admits(&with_cookie(&format!("{SESSION_COOKIE}="))));
        assert!(!sessions.admits(&HeaderMap::new()));
    }

    #[test]
    fn closed_session_no_longer_admits() {
        let sessions = BrowserSessions::default();
        let cookie = with_cookie(&format!("{SESSION_COOKIE}={}", sessions.open()));
        sessions.close(&cookie);
        assert!(!sessions.admits(&cookie));
    }

    #[test]
    fn session_ids_are_unique_and_long() {
        let sessions = BrowserSessions::default();
        let (a, b) = (sessions.open(), sessions.open());
        assert_ne!(a, b);
        assert!(
            a.len() >= 43,
            "32 random bytes base64url-encode to 43 chars"
        );
    }

    #[test]
    fn console_paths_are_the_page_and_its_files() {
        assert!(is_console_path("/"));
        assert!(is_console_path("/ui/app.js"));
        assert!(is_console_path("/ui/session"));
        assert!(!is_console_path("/v1/boxes"));
        assert!(!is_console_path("/uix"));
    }

    #[tokio::test]
    async fn every_asset_is_served_with_its_type_and_policy() {
        for (name, media_type, _) in ASSETS {
            let response = asset(Path((*name).to_string())).await;
            assert_eq!(response.status(), StatusCode::OK, "{name}");
            assert_eq!(response.headers()[CONTENT_TYPE], *media_type, "{name}");
            assert_eq!(
                response.headers()[CONTENT_SECURITY_POLICY],
                CONTENT_SECURITY
            );
        }
        assert_eq!(
            asset(Path("../Cargo.toml".to_string())).await.status(),
            StatusCode::NOT_FOUND
        );
    }
}
