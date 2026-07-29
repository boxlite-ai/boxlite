// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! What the request span actually carries.
//!
//! `telemetry_host` having a unit test is not enough: the thing that matters is
//! that the span is built from it rather than from the raw `Host` header, and
//! that is only observable by capturing the span the proxy really emits.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use boxlite_proxy::body::{self, Body};
use boxlite_proxy::config::{Config, OidcConfig};
use boxlite_proxy::proxy::Proxy;
use http::{Method, Request};
use tracing::field::{Field, Visit};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;

type Captured = Arc<Mutex<Vec<(String, HashMap<String, String>)>>>;

/// Records every span's name and fields, including values recorded after
/// creation, so `http.response.status_code` is visible too.
struct Capture(Captured);

#[derive(Default)]
struct Fields(HashMap<String, String>);

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(
            field.name().to_string(),
            format!("{value:?}").trim_matches('"').to_string(),
        );
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().to_string(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
}

impl<S> Layer<S> for Capture
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        id: &tracing::span::Id,
        ctx: Context<'_, S>,
    ) {
        let mut fields = Fields::default();
        attrs.record(&mut fields);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(fields);
        }
    }

    fn on_record(
        &self,
        id: &tracing::span::Id,
        values: &tracing::span::Record<'_>,
        ctx: Context<'_, S>,
    ) {
        if let Some(span) = ctx.span(id)
            && let Some(fields) = span.extensions_mut().get_mut::<Fields>()
        {
            values.record(fields);
        }
    }

    fn on_close(&self, id: tracing::span::Id, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(&id)
            && let Some(fields) = span.extensions().get::<Fields>()
        {
            self.0
                .lock()
                .expect("capture lock")
                .push((span.name().to_string(), fields.0.clone()));
        }
    }
}

/// Drives one request through the real `Proxy::handle` and returns the fields of
/// the `http.server.request` span it emitted.
///
/// One current-thread runtime, with the capturing subscriber installed around
/// the whole of it: `with_default` is thread-local, so the future has to stay on
/// this thread for the span to be seen.
fn span_for(host: &str, method: Method, path: &str) -> HashMap<String, String> {
    boxlite_proxy::install_crypto_provider();

    let captured: Captured = Arc::default();
    let subscriber = tracing_subscriber::registry().with(Capture(captured.clone()));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime builds");

    let host = host.to_string();
    let path = path.to_string();

    tracing::subscriber::with_default(subscriber, || {
        runtime.block_on(async move {
            let proxy = Proxy::new(Config {
                proxy_port: 0,
                proxy_protocol: "https".into(),
                proxy_api_key: "test-proxy-key".into(),
                cookie_domain: None,
                tls: None,
                boxlite_api_url: "http://api.invalid".into(),
                oidc: OidcConfig::default(),
                redis: None,
                preview_warning_enabled: false,
                shutdown_timeout: std::time::Duration::from_secs(1),
            })
            .await
            .expect("proxy builds");

            let request = Request::builder()
                .method(method)
                .uri(path)
                .header(http::header::HOST, host)
                .header(http::header::ORIGIN, "https://app.test")
                .header("access-control-request-method", "POST")
                .body(body::empty())
                .expect("valid request");
            let remote: SocketAddr = "10.0.0.1:5000".parse().expect("valid address");

            let response: http::Response<Body> = proxy.handle(request, remote).await;
            drop(response);
        });
    });

    let spans = captured.lock().expect("capture lock").clone();
    spans
        .into_iter()
        .find(|(name, _)| name == "http.server.request")
        .map(|(_, fields)| fields)
        .expect("the proxy emitted an http.server.request span")
}

#[test]
fn the_span_reports_the_base_host_not_the_preview_token() {
    let fields = span_for(
        "3999-s3cr3t-s1gn3d-t0k3n.proxy.test",
        Method::GET,
        "/health",
    );

    assert_eq!(
        fields.get("server.address").map(String::as_str),
        Some("proxy.test"),
        "the span must be built from the base host, not the raw Host header"
    );
    assert!(
        !fields
            .values()
            .any(|value| value.contains("s3cr3t-s1gn3d-t0k3n")),
        "no span field may carry the preview token: {fields:?}"
    );
}

#[test]
fn the_span_records_the_status_and_omits_the_query_string() {
    let fields = span_for(
        "proxy.test",
        Method::GET,
        "/health?BOXLITE_BOX_AUTH_KEY=s3cr3t",
    );

    assert_eq!(fields.get("url.path").map(String::as_str), Some("/health"));
    assert_eq!(
        fields.get("http.request.method").map(String::as_str),
        Some("GET")
    );
    assert_eq!(
        fields.get("http.response.status_code").map(String::as_str),
        Some("200")
    );
    assert!(
        !fields.values().any(|value| value.contains("s3cr3t")),
        "the query string must never reach a span: {fields:?}"
    );
}

/// A preflight is answered before routing, and used to escape instrumentation.
#[test]
fn a_cors_preflight_is_also_traced() {
    let fields = span_for("3000-abcdefghijkl.proxy.test", Method::OPTIONS, "/app");

    assert_eq!(
        fields.get("http.response.status_code").map(String::as_str),
        Some("204"),
        "the preflight the proxy answers itself must still be traced"
    );
}
