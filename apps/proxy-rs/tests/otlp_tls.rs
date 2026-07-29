// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The OTLP exporter's HTTP client must be able to speak TLS.
//!
//! `opentelemetry-otlp` depends on a different major of `reqwest` than the rest
//! of this crate, with default features off, so that copy ships with no TLS
//! unless something turns it on. The `otlp-tls` entry in Cargo.toml is that
//! something, and without it every `https://` collector fails at connect — which
//! is invisible until a deployment tries it.
//!
//! This test guards one half of that: it fails if the entry loses its TLS
//! features. The other half — `opentelemetry-otlp` moving to a `reqwest` major
//! the entry no longer unifies with — is a *compile* error instead, because
//! `telemetry::http_client` hands the exporters a client from this dependency
//! and `HttpClient` is implemented only for the major `opentelemetry-http`
//! itself uses.

/// Connects to a port nothing is listening on, so the request always fails —
/// what matters is *how*. With TLS compiled in the connector opens a socket and
/// the OS refuses it; without TLS it rejects the URL before any socket exists.
///
/// Both are `is_connect()` errors, so the message is the only thing that
/// separates them. reqwest exposes no typed variant for "scheme unsupported",
/// which is why this reads text rather than matching a discriminant — and why
/// it is coupled to hyper's wording. If that string ever changes, this test
/// goes quiet rather than failing loudly, so treat a wording change in
/// hyper-util as a reason to re-check it.
#[test]
fn the_otlp_http_client_supports_https() {
    boxlite_proxy::install_crypto_provider();

    let client = otlp_tls::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .expect("the OTLP HTTP client builds");

    // Port 1, loopback: reserved, and never bound in practice.
    let error = client
        .get("https://127.0.0.1:1/v1/traces")
        .send()
        .expect_err("nothing is listening, so this cannot succeed");

    let chain = format!("{error:?}");
    assert!(
        !chain.contains("scheme is not http"),
        "the OTLP HTTP client was built without TLS, so every https:// collector \
         would fail at connect. Check the `otlp-tls` entry in Cargo.toml. Got: {chain}"
    );
    assert!(
        error.is_connect(),
        "expected a refused connection, meaning a socket was actually opened. Got: {chain}"
    );
}
