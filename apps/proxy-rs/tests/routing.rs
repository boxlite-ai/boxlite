// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Routing and CORS behaviour of a fully built `Proxy`.
//!
//! Nothing here reaches the network: every case is decided before the proxy
//! would need to ask the control plane anything.

use std::net::SocketAddr;
use std::sync::Arc;

use boxlite_proxy::body::{self, Body};
use boxlite_proxy::config::{Config, OidcConfig};
use boxlite_proxy::proxy::Proxy;
use http::{Method, Request, Response, StatusCode};
use http_body_util::BodyExt;

const CLIENT: &str = "10.0.0.1:5000";

async fn proxy(preview_warning_enabled: bool) -> Arc<Proxy> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    Proxy::new(Config {
        proxy_port: 0,
        proxy_protocol: "https".into(),
        proxy_api_key: "test-proxy-key".into(),
        cookie_domain: None,
        tls: None,
        boxlite_api_url: "http://api.invalid".into(),
        oidc: OidcConfig::default(),
        redis: None,
        preview_warning_enabled,
        shutdown_timeout: std::time::Duration::from_secs(1),
    })
    .await
    .expect("proxy builds without touching the network")
}

async fn send(proxy: &Arc<Proxy>, request: Request<Body>) -> Response<Body> {
    let remote: SocketAddr = CLIENT.parse().expect("valid address");
    proxy.handle(request, remote).await
}

fn get(host: &str, path: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::GET)
        .uri(path)
        .header(http::header::HOST, host);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body::empty()).expect("valid request")
}

async fn text(response: Response<Body>) -> String {
    String::from_utf8_lossy(
        &response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes(),
    )
    .into_owned()
}

#[tokio::test]
async fn health_reports_the_build_version() {
    let proxy = proxy(false).await;

    let response = send(&proxy, get("proxy.test", "/health", &[])).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_str(&text(response).await).expect("json response");
    assert_eq!(body["status"], "ok");
    assert!(body["version"].is_string());
}

#[tokio::test]
async fn unknown_routes_on_the_base_host_are_not_found() {
    let proxy = proxy(false).await;

    let response = send(&proxy, get("proxy.test", "/nope", &[])).await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value =
        serde_json::from_str(&text(response).await).expect("json error envelope");
    assert_eq!(body["code"], "NOT_FOUND");
    assert_eq!(body["path"], "/nope");
}

#[tokio::test]
async fn preflight_is_answered_without_reaching_the_box() {
    let proxy = proxy(false).await;

    let request = Request::builder()
        .method(Method::OPTIONS)
        .uri("/")
        .header(http::header::HOST, "3000-abcdefghijkl.proxy.test")
        .header(http::header::ORIGIN, "https://app.test")
        .header("access-control-request-method", "POST")
        .body(body::empty())
        .expect("valid request");

    let response = send(&proxy, request).await;

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "https://app.test"
    );
}

// Regression: the opt-out was read before the header was stripped but the
// headers were recomputed after, so an opting-out client still got them.
#[tokio::test]
async fn opting_out_of_cors_suppresses_the_headers_on_the_response() {
    let proxy = proxy(false).await;

    let response = send(
        &proxy,
        get(
            "proxy.test",
            "/health",
            &[
                (http::header::ORIGIN.as_str(), "https://app.test"),
                ("X-BoxLite-Disable-CORS", "true"),
            ],
        ),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("access-control-allow-origin"),
        None,
        "the client asked us not to add CORS headers"
    );
}

#[tokio::test]
async fn cors_headers_are_added_to_error_responses_too() {
    let proxy = proxy(false).await;

    let response = send(
        &proxy,
        get(
            "proxy.test",
            "/nope",
            &[(http::header::ORIGIN.as_str(), "https://app.test")],
        ),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "https://app.test",
        "a browser must be able to read the error"
    );
}

#[tokio::test]
async fn browsers_see_the_warning_page_before_the_box_is_contacted() {
    let proxy = proxy(true).await;

    let response = send(
        &proxy,
        get(
            "3000-abcdefghijkl.proxy.test",
            "/app",
            &[("user-agent", "Mozilla/5.0 Chrome/120.0 Safari/537.36")],
        ),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(http::header::CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    assert!(text(response).await.contains("Preview URL Warning"));
}

#[tokio::test]
async fn accepting_the_warning_sets_the_cookie_and_returns_the_visitor() {
    let proxy = proxy(true).await;

    let request = Request::builder()
        .method(Method::POST)
        .uri("/accept-boxlite-preview-warning?redirect=https%3A%2F%2F3000-abcdefghijkl.proxy.test%2Fapp")
        .header(http::header::HOST, "3000-abcdefghijkl.proxy.test")
        .body(body::empty())
        .expect("valid request");

    let response = send(&proxy, request).await;

    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        response.headers().get(http::header::LOCATION).unwrap(),
        "https://3000-abcdefghijkl.proxy.test/app"
    );
    assert!(
        response
            .headers()
            .get(http::header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("boxlite-preview-page-accepted=true")
    );
}

// The `redirect` parameter is percent-decoded before it is checked, so an
// encoded backslash or tab arrives as a literal one. A browser strips tabs and
// reads `\` as `/`, turning these into off-site absolute URLs.
#[tokio::test]
async fn the_acknowledgement_endpoint_cannot_be_turned_into_an_open_redirect() {
    let proxy = proxy(true).await;

    for (name, encoded) in [
        ("absolute", "https%3A%2F%2Fevil.test%2Fphish"),
        ("protocol-relative", "%2F%2Fevil.test%2Fphish"),
        ("backslash", "%2F%5Cevil.test%2Fphish"),
        ("tab", "%2F%09%2Fevil.test"),
        ("crlf", "%2F%0D%0A%2Fevil.test"),
    ] {
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!(
                "/accept-boxlite-preview-warning?redirect={encoded}"
            ))
            .header(http::header::HOST, "3000-abcdefghijkl.proxy.test")
            .body(body::empty())
            .expect("valid request");

        let response = send(&proxy, request).await;

        assert_eq!(response.status(), StatusCode::FOUND, "{name}");
        assert_eq!(
            response.headers().get(http::header::LOCATION).unwrap(),
            "/",
            "{name}: must not send the visitor off the proxy"
        );
    }
}

#[tokio::test]
async fn a_malformed_direct_box_id_is_rejected_before_any_lookup() {
    let proxy = proxy(false).await;

    // Hex for "53MOZ3jp/../" — a path-traversal attempt through the box ID.
    let response = send(
        &proxy,
        get("3000-d-35334d4f5a336a702f2e2e2f.proxy.test", "/", &[]),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        text(response)
            .await
            .contains("invalid direct preview box ID"),
        "the box ID must be rejected, not passed to the API"
    );
}
