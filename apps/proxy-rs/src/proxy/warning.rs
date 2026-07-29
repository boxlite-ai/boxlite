// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The interstitial shown to browsers on their first visit to a preview URL.
//!
//! Its purpose is to stop a preview link from being mistaken for a first-party
//! site, so it is shown to people and skipped for everything else: API clients,
//! WebSocket upgrades, and the terminal port.

use std::time::Duration;

use cookie::SameSite;
use http::{HeaderMap, Request, Response, StatusCode, Uri};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};

use crate::body::Body;
use crate::response::{self, CookieOptions};

pub const SKIP_HEADER: &str = "X-BoxLite-Skip-Preview-Warning";
pub const ACCEPT_COOKIE_NAME: &str = "boxlite-preview-page-accepted";
pub const ACCEPT_PATH: &str = "/accept-boxlite-preview-warning";

const ACCEPT_COOKIE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

const PAGE: &str = include_str!("warning_page.html");

/// Browsers the warning is shown to. Anything else — curl, an SDK, a crawler —
/// is served the box directly.
const BROWSERS: &[(&str, &[&str])] = &[
    ("edge", &["Edg/", "Edge/", "EdgA/", "EdgiOS/"]),
    ("opera", &["OPR/", "Opera"]),
    ("vivaldi", &["Vivaldi"]),
    ("brave", &["Brave"]),
    ("samsung", &["SamsungBrowser"]),
    ("chrome", &["Chrome/", "CriOS/"]),
    ("firefox", &["Firefox/", "FxiOS/"]),
    ("safari", &["Safari/"]),
];

/// Identifies the browser family, in precedence order — Edge and Opera both
/// claim to be Chrome, and Chrome claims to be Safari.
pub fn browser_name(user_agent: &str) -> Option<&'static str> {
    BROWSERS
        .iter()
        .find(|(_, markers)| markers.iter().any(|marker| user_agent.contains(marker)))
        .map(|(name, _)| *name)
}

/// `preview_host` is `None` when the request did not arrive on a preview
/// hostname, which is how the proxy's own endpoints are recognised.
pub fn should_warn(
    headers: &HeaderMap,
    method: &http::Method,
    uri: &Uri,
    preview_host: Option<&super::host::PreviewHost>,
) -> bool {
    if headers
        .get(SKIP_HEADER)
        .is_some_and(|value| value == "true")
    {
        return false;
    }

    let user_agent = headers
        .get(http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if browser_name(user_agent).is_none() {
        return false;
    }

    if is_websocket_upgrade(headers) {
        return false;
    }

    if response::read_cookie(headers, ACCEPT_COOKIE_NAME).as_deref() == Some("true") {
        return false;
    }

    // The proxy's own endpoints are not previews and have nothing to warn about.
    if preview_host.is_none()
        && method == http::Method::GET
        && matches!(uri.path(), "/callback" | "/health")
    {
        return false;
    }

    // The page posts back to this path, so warning on it would be a loop.
    if uri.path() == ACCEPT_PATH {
        return false;
    }

    // The terminal is opened from the dashboard, which has already shown its own
    // context; an interstitial there would break the embedded session.
    if preview_host.is_some_and(|host| host.target_port == super::TERMINAL_PORT) {
        return false;
    }

    true
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let header = |name: http::header::HeaderName| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase()
    };

    header(http::header::UPGRADE) == "websocket" && header(http::header::CONNECTION) == "upgrade"
}

/// Renders the interstitial for the URL the client was trying to reach.
pub fn page<B>(request: &Request<B>, request_host: &str, https: bool) -> Response<Body> {
    let scheme = if https { "https://" } else { "http://" };
    let target = format!(
        "{scheme}{request_host}{}",
        request
            .uri()
            .path_and_query()
            .map(|path| path.as_str())
            .unwrap_or("/")
    );
    let accept_url = format!(
        "{ACCEPT_PATH}?redirect={}",
        utf8_percent_encode(&target, NON_ALPHANUMERIC)
    );

    // The target URL is attacker-controlled (it is just the request line), so it
    // is escaped rather than interpolated raw.
    response::html(
        PAGE.replace("{{PREVIEW_URL}}", &escape_html(&target))
            .replace("{{ACCEPT_URL}}", &escape_html(&accept_url)),
    )
}

/// Records the acknowledgement and returns the visitor to where they were going.
pub fn accept<B>(request: &Request<B>, request_host: &str, https: bool) -> Response<Body> {
    let mut response = response::redirect(
        StatusCode::FOUND,
        &safe_redirect_target(request.uri(), request_host),
    );

    response::set_cookie(
        &mut response,
        ACCEPT_COOKIE_NAME,
        "true",
        CookieOptions {
            domain: request_host.split(':').next().unwrap_or(request_host),
            max_age: Some(ACCEPT_COOKIE_MAX_AGE),
            secure: https,
            http_only: true,
            // Preview URLs are embedded in cross-origin iframes, which requires
            // SameSite=None — only valid on a secure cookie.
            same_site: Some(if https { SameSite::None } else { SameSite::Lax }),
        },
    );

    response
}

/// Only same-site targets are honoured, so the acknowledgement endpoint cannot
/// be used as an open redirect to an attacker's site.
fn safe_redirect_target(uri: &Uri, request_host: &str) -> String {
    match super::host::query_param(uri, "redirect") {
        Some(target) if super::host::is_same_site(&target, request_host) => target,
        _ => "/".to_string(),
    }
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::body_to_string;

    fn request(uri: &str, headers: &[(&str, &str)]) -> Request<()> {
        let mut builder = Request::builder().uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(()).expect("valid request")
    }

    #[test]
    fn identifies_browsers_by_precedence() {
        let chrome = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
        let edge = format!("{chrome} Edg/120.0");
        let safari = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

        assert_eq!(browser_name(chrome), Some("chrome"));
        assert_eq!(browser_name(&edge), Some("edge"), "Edge also claims Chrome");
        assert_eq!(browser_name(safari), Some("safari"));
        assert_eq!(browser_name("curl/8.4.0"), None);
        assert_eq!(browser_name("Go-http-client/1.1"), None);
        assert_eq!(browser_name(""), None);
    }

    fn preview(port: &str) -> super::super::host::PreviewHost {
        super::super::host::PreviewHost {
            target_port: port.into(),
            box_id_or_token: "box".into(),
            base_host: "proxy.test".into(),
        }
    }

    #[test]
    fn warns_browsers_but_not_tools() {
        let chrome = "Mozilla/5.0 Chrome/120.0 Safari/537.36";
        let path: Uri = "/app".parse().unwrap();
        let host = preview("3000");

        assert!(should_warn(
            request("/app", &[("user-agent", chrome)]).headers(),
            &http::Method::GET,
            &path,
            Some(&host)
        ));
        assert!(!should_warn(
            request("/app", &[("user-agent", "curl/8.4.0")]).headers(),
            &http::Method::GET,
            &path,
            Some(&host)
        ));
    }

    #[test]
    fn skips_websockets_acknowledged_visitors_and_the_opt_out() {
        let chrome = "Mozilla/5.0 Chrome/120.0 Safari/537.36";
        let path: Uri = "/app".parse().unwrap();
        let host = preview("3000");
        let skips = |request: &Request<()>| {
            !should_warn(request.headers(), &http::Method::GET, &path, Some(&host))
        };

        assert!(skips(&request(
            "/app",
            &[
                ("user-agent", chrome),
                ("upgrade", "websocket"),
                ("connection", "Upgrade"),
            ],
        )));
        assert!(skips(&request(
            "/app",
            &[
                ("user-agent", chrome),
                ("cookie", "boxlite-preview-page-accepted=true"),
            ],
        )));
        assert!(skips(&request(
            "/app",
            &[("user-agent", chrome), (SKIP_HEADER, "true")]
        )));
    }

    #[test]
    fn skips_the_terminal_port_and_the_proxy_own_endpoints() {
        let chrome = "Mozilla/5.0 Chrome/120.0 Safari/537.36";
        let browser = request("/health", &[("user-agent", chrome)]);

        assert!(!should_warn(
            browser.headers(),
            &http::Method::GET,
            &"/app".parse().unwrap(),
            Some(&preview(super::super::TERMINAL_PORT))
        ));
        assert!(!should_warn(
            browser.headers(),
            &http::Method::GET,
            &"/health".parse().unwrap(),
            None
        ));
        assert!(!should_warn(
            browser.headers(),
            &http::Method::GET,
            &"/callback".parse().unwrap(),
            None
        ));
    }

    // The `Host` header is the injection vector here: hyper rejects `<` and `>`
    // in a request target, but header values may contain them, and the host is
    // reflected into the page.
    #[tokio::test]
    async fn page_escapes_the_reflected_host() {
        let request = request("/app", &[]);
        let rendered = body_to_string(
            page(
                &request,
                "3000-box.proxy.test/<script>alert(1)</script>",
                true,
            )
            .into_body(),
        )
        .await;

        assert!(
            !rendered.contains("<script>alert(1)"),
            "a reflected host must not be able to inject markup"
        );
        assert!(
            rendered.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "and must still be shown to the visitor"
        );
    }

    #[test]
    fn accept_only_redirects_back_to_the_same_host() {
        let same_host = request(
            "/accept-boxlite-preview-warning?redirect=https%3A%2F%2F3000-box.proxy.test%2Fapp",
            &[],
        );
        assert_eq!(
            accept(&same_host, "3000-box.proxy.test", true)
                .headers()
                .get(http::header::LOCATION)
                .unwrap(),
            "https://3000-box.proxy.test/app"
        );

        let off_host = request(
            "/accept-boxlite-preview-warning?redirect=https%3A%2F%2Fevil.test%2Fphish",
            &[],
        );
        assert_eq!(
            accept(&off_host, "3000-box.proxy.test", true)
                .headers()
                .get(http::header::LOCATION)
                .unwrap(),
            "/",
            "an off-host redirect target must be dropped"
        );

        let missing = request("/accept-boxlite-preview-warning", &[]);
        assert_eq!(
            accept(&missing, "3000-box.proxy.test", true)
                .headers()
                .get(http::header::LOCATION)
                .unwrap(),
            "/"
        );
    }

    #[test]
    fn accept_marks_the_cookie_cross_site_only_over_https() {
        let request = request("/accept-boxlite-preview-warning", &[]);

        let secure = accept(&request, "3000-box.proxy.test", true);
        let header = secure
            .headers()
            .get(http::header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(header.contains("SameSite=None"), "got {header}");
        assert!(header.contains("Secure"), "got {header}");

        let insecure = accept(&request, "3000-box.proxy.test", false);
        let header = insecure
            .headers()
            .get(http::header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(header.contains("SameSite=Lax"), "got {header}");
    }
}
