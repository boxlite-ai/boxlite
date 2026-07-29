// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The OIDC callback's rejection boundary.
//!
//! Every case here is refused before the proxy would exchange a code with the
//! identity provider, so none of them touch the network. That ordering is the
//! point: a caller that cannot present a well-formed, signed state and a
//! matching PKCE cookie must never reach the token endpoint.

use std::net::SocketAddr;
use std::sync::Arc;

use boxlite_proxy::body::{self, Body};
use boxlite_proxy::config::{Config, OidcConfig};
use boxlite_proxy::proxy::Proxy;
use boxlite_proxy::signed_cookie::CookieSigner;
use http::{Request, Response, StatusCode};
use http_body_util::BodyExt;

const PROXY_API_KEY: &str = "test-proxy-key";
const BASE_HOST: &str = "proxy.test";

async fn proxy() -> Arc<Proxy> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    Proxy::new(Config {
        proxy_port: 0,
        proxy_protocol: "https".into(),
        proxy_api_key: PROXY_API_KEY.into(),
        cookie_domain: None,
        tls: None,
        boxlite_api_url: "http://api.invalid".into(),
        oidc: OidcConfig {
            // Unreachable on purpose: reaching it would mean a rejection was missed.
            domain: "https://issuer.invalid/".into(),
            client_id: "cid".into(),
            ..OidcConfig::default()
        },
        redis: None,
        preview_warning_enabled: false,
        shutdown_timeout: std::time::Duration::from_secs(1),
    })
    .await
    .expect("proxy builds")
}

/// A state signed exactly the way the proxy signs its own.
fn signed_state(key: &str, return_to: &str) -> String {
    let payload = serde_json::json!({
        "return_to": return_to,
        "box_id": "abcdefghijkl",
        "nonce": "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy",
    });
    CookieSigner::new(key).encode("oidc_state", &payload.to_string())
}

fn pkce_cookie(key: &str) -> String {
    format!(
        "pkce_verifier={}",
        CookieSigner::new(key).encode("pkce_verifier", "a-code-verifier")
    )
}

async fn callback(query: &str, headers: &[(&str, &str)]) -> Response<Body> {
    let mut builder = Request::builder()
        .uri(format!("/callback?{query}"))
        .header(http::header::HOST, BASE_HOST);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }

    let remote: SocketAddr = "10.0.0.1:5000".parse().expect("valid address");
    proxy()
        .await
        .handle(builder.body(body::empty()).expect("valid request"), remote)
        .await
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
async fn surfaces_a_provider_error() {
    let response = callback("error=access_denied&error_description=user+said+no", &[]).await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(text(response).await.contains("user said no"));
}

#[tokio::test]
async fn requires_a_code_and_a_state() {
    let no_code = callback("state=anything", &[]).await;
    assert_eq!(no_code.status(), StatusCode::BAD_REQUEST);
    assert!(text(no_code).await.contains("no code in callback"));

    let no_state = callback("code=abc", &[]).await;
    assert_eq!(no_state.status(), StatusCode::BAD_REQUEST);
    assert!(text(no_state).await.contains("no state in callback"));
}

#[tokio::test]
async fn rejects_an_unsigned_state() {
    // What the previous implementation accepted: bare base64url JSON.
    let forged = {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::json!({"return_to": "https://proxy.test/", "box_id": "b", "nonce": "n"})
                .to_string(),
        )
    };

    let response = callback(&format!("code=abc&state={forged}"), &[]).await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(text(response).await.contains("invalid callback state"));
}

#[tokio::test]
async fn rejects_a_state_signed_with_another_key() {
    let state = signed_state("someone-elses-key", "https://proxy.test/app");

    let response = callback(
        &format!("code=abc&state={}", urlencode(&state)),
        &[("cookie", &pkce_cookie(PROXY_API_KEY))],
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(text(response).await.contains("invalid callback state"));
}

// Regression: the state is signed, but a signed state can still be *minted* by
// an attacker, because the proxy answers on any hostname and `return_to` was
// built from an unvalidated Host header.
#[tokio::test]
async fn refuses_to_send_the_browser_off_the_proxy() {
    let state = signed_state(PROXY_API_KEY, "https://evil.test/phish");

    let response = callback(
        &format!("code=abc&state={}", urlencode(&state)),
        &[("cookie", &pkce_cookie(PROXY_API_KEY))],
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        text(response).await.contains("points off this proxy"),
        "an off-site return_to must not be honoured"
    );
}

#[tokio::test]
async fn requires_the_pkce_cookie_that_started_the_flow() {
    let state = signed_state(PROXY_API_KEY, "https://3000-box.proxy.test/app");

    let missing = callback(&format!("code=abc&state={}", urlencode(&state)), &[]).await;
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    assert!(
        text(missing)
            .await
            .contains("authentication state verification failed"),
        "a callback with no verifier cannot be a flow this proxy started"
    );

    // A verifier cookie signed by someone else is no better than none.
    let forged = callback(
        &format!("code=abc&state={}", urlencode(&state)),
        &[("cookie", &pkce_cookie("someone-elses-key"))],
    )
    .await;
    assert_eq!(forged.status(), StatusCode::BAD_REQUEST);
    assert!(
        text(forged)
            .await
            .contains("authentication state verification failed")
    );
}

fn urlencode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}
