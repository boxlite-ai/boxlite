// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Where a terminal preview hostname actually lands.
//!
//! `terminal::allowed_path` is unit-tested on its own, but that only matters if
//! the request path is really routed through it. These drive a real
//! `Proxy::handle` against a stub control plane and a stub runner, and assert on
//! what the runner was asked for — including that a refused path never reaches
//! it at all.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use boxlite_proxy::body::{self, Body};
use boxlite_proxy::config::{Config, OidcConfig};
use boxlite_proxy::proxy::Proxy;
use http::{Method, Request, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

const BOX_ID: &str = "AbCdEf123456";
const TOKEN: &str = "s3cr3tt0k3n";

/// Every request line the stub runner saw, in order.
type Seen = Arc<Mutex<Vec<String>>>;

async fn serve<F>(handler: F) -> (SocketAddr, tokio::task::JoinHandle<()>)
where
    F: Fn(Request<hyper::body::Incoming>) -> Response<Body> + Send + Sync + Clone + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
    let address = listener.local_addr().expect("has an address");

    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let handler = handler.clone();
            tokio::spawn(async move {
                let _ = http1::Builder::new()
                    .serve_connection(
                        TokioIo::new(stream),
                        service_fn(move |request| {
                            let handler = handler.clone();
                            async move { Ok::<_, Infallible>(handler(request)) }
                        }),
                    )
                    .with_upgrades()
                    .await;
            });
        }
    });

    (address, task)
}

fn json(status: StatusCode, payload: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(body::full(payload.to_string()))
        .expect("valid response")
}

/// Stands in for the control plane: the box is private, the token resolves to
/// it, and it lives on the stub runner.
async fn control_plane(runner: SocketAddr) -> SocketAddr {
    let (address, _) = serve(move |request: Request<hyper::body::Incoming>| {
        let path = request.uri().path().to_string();
        if path.ends_with("/public") {
            return json(
                StatusCode::FORBIDDEN,
                r#"{"statusCode":403,"message":"private"}"#,
            );
        }
        if path.ends_with("/box-id") {
            return Response::builder()
                .status(StatusCode::OK)
                .body(body::full(BOX_ID))
                .expect("valid response");
        }
        if path.starts_with("/runners/by-box/") {
            return json(
                StatusCode::OK,
                &format!(r#"{{"proxyUrl":"http://{runner}","apiKey":"runner-key"}}"#),
            );
        }
        json(StatusCode::OK, "true")
    })
    .await;
    address
}

async fn proxy_for(api: SocketAddr) -> Arc<Proxy> {
    boxlite_proxy::install_crypto_provider();
    Proxy::new(Config {
        proxy_port: 0,
        proxy_protocol: "https".into(),
        proxy_api_key: "test-proxy-key".into(),
        cookie_domain: None,
        tls: None,
        boxlite_api_url: format!("http://{api}"),
        oidc: OidcConfig::default(),
        redis: None,
        preview_warning_enabled: false,
        shutdown_timeout: std::time::Duration::from_secs(1),
    })
    .await
    .expect("proxy builds")
}

async fn request_on(label: &str, path: &str, method: Method) -> (StatusCode, Vec<String>) {
    let seen: Seen = Arc::default();
    let recorder = seen.clone();

    let (runner, _) = serve(move |request: Request<hyper::body::Incoming>| {
        let target = request
            .uri()
            .path_and_query()
            .map(|target| target.as_str().to_string())
            .unwrap_or_default();
        recorder
            .lock()
            .expect("lock")
            .push(format!("{} {target}", request.method()));
        json(StatusCode::OK, r#"{"execution_id":"exec-1"}"#)
    })
    .await;

    let proxy = proxy_for(control_plane(runner).await).await;

    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(http::header::HOST, format!("{label}-{TOKEN}.proxy.test"))
        .body(body::empty())
        .expect("valid request");

    let response = proxy
        .handle(request, "10.0.0.1:5000".parse().expect("valid address"))
        .await;
    let status = response.status();
    let _ = response.into_body().collect().await;

    let observed = seen.lock().expect("lock").clone();
    (status, observed)
}

async fn terminal_request(path: &str, method: Method) -> (StatusCode, Vec<String>) {
    request_on("term", path, method).await
}

/// 22222 is an ordinary guest port again: it is dialled inside the box over a
/// tunnel, not answered by the runner's own API.
#[tokio::test]
async fn the_old_terminal_port_is_no_longer_special() {
    let (status, seen) = request_on("22222", "/", Method::GET).await;

    assert_eq!(
        seen,
        vec![format!(
            "CONNECT /v1/boxes/{BOX_ID}/network/tunnel?port=22222"
        )],
        "22222 must be tunnelled into the box like any other port"
    );
    // The stub runner answers the CONNECT with JSON rather than a tunnel.
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_terminal_hostname_reaches_the_runner_box_api() {
    let (status, seen) = terminal_request("/exec", Method::POST).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        seen,
        vec![format!("POST /v1/boxes/{BOX_ID}/exec")],
        "the terminal must land on the runner's exec API, not the old toolbox path"
    );
}

#[tokio::test]
async fn the_execution_lifecycle_is_reachable() {
    let (status, seen) = terminal_request("/executions/exec-1/resize", Method::POST).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        seen,
        vec![format!("POST /v1/boxes/{BOX_ID}/executions/exec-1/resize")]
    );
}

/// The runner serves files and metrics on the same prefix. A terminal link
/// grants a shell, and must not also grant those.
#[tokio::test]
async fn the_rest_of_the_box_api_is_refused_before_the_runner_is_contacted() {
    for path in ["/files", "/metrics", "/executions/exec-1/../../files"] {
        let (status, seen) = terminal_request(path, Method::GET).await;

        assert_eq!(status, StatusCode::NOT_FOUND, "{path} should be refused");
        assert!(
            seen.is_empty(),
            "{path} must not reach the runner at all, saw {seen:?}"
        );
    }
}
