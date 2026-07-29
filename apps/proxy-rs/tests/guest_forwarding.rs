// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! End-to-end forwarding to a guest port.
//!
//! Stands up a fake runner that speaks the CONNECT tunnel protocol, then drives
//! a real request through the real client stack. This is the path that carries
//! every preview request, and the one place where the box ID authority, the
//! preview `Host`, and the tunnel all have to line up.

use std::sync::Arc;
use std::time::Duration;

use boxlite_proxy::api::{ApiClient, RunnerInfo};
use boxlite_proxy::body;
use boxlite_proxy::cache::Cache;
use boxlite_proxy::proxy::activity::{ActivityHandle, ActivityReporter};
use boxlite_proxy::proxy::forward::{RequestTarget, forward};
use boxlite_proxy::proxy::runners::RunnerDirectory;
use boxlite_proxy::proxy::upstream::{Clients, Upstream};
use http::header::{HeaderName, HeaderValue};
use http_body_util::{BodyExt, Empty};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const BOX_ID: &str = "AbCdEf123456";
const PREVIEW_HOST: &str = "3000-d-416243644566313233343536.proxy.test";

/// What the fake runner observed, so the test can assert on the wire format
/// rather than on the proxy's own bookkeeping.
struct Observed {
    connect_line: String,
    connect_headers: Vec<String>,
    guest_line: String,
    guest_headers: Vec<String>,
}

/// Accepts one connection: a CONNECT tunnel request, then the HTTP request the
/// proxy sends through it.
async fn fake_runner(listener: TcpListener) -> Observed {
    let (stream, _) = listener.accept().await.expect("runner accepts");
    let mut reader = BufReader::new(stream);

    let (connect_line, connect_headers) = read_request_head(&mut reader).await;
    reader
        .get_mut()
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .expect("runner accepts the tunnel");

    let (guest_line, guest_headers) = read_request_head(&mut reader).await;
    reader
        .get_mut()
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\nthrough-l4-ok")
        .await
        .expect("guest responds");

    Observed {
        connect_line,
        connect_headers,
        guest_line,
        guest_headers,
    }
}

async fn read_request_head<S>(reader: &mut BufReader<S>) -> (String, Vec<String>)
where
    S: tokio::io::AsyncRead + Unpin,
{
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .await
        .expect("reads the request line");

    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("reads a header");
        if line == "\r\n" || line.is_empty() {
            break;
        }
        headers.push(line.trim_end().to_string());
    }

    (request_line.trim_end().to_string(), headers)
}

/// A directory that already knows where the box lives, so no control-plane call
/// is made during the test.
async fn seeded_clients(runner_address: String) -> Clients {
    let runners = Cache::in_memory();
    runners
        .set(
            BOX_ID,
            RunnerInfo {
                api_url: format!("http://{runner_address}"),
                api_key: "runner-key".into(),
            },
            Duration::from_secs(60),
        )
        .await;

    Clients::new(Arc::new(RunnerDirectory::new(
        Arc::new(ApiClient::new("http://api.invalid", "proxy-key").expect("client builds")),
        runners,
    )))
}

/// An activity handle whose reporter will not call the API, because the box is
/// already marked as recently reported.
async fn quiet_activity() -> ActivityHandle {
    let reported = Cache::in_memory();
    reported.set(BOX_ID, true, Duration::from_secs(60)).await;

    Arc::new(ActivityReporter::new(
        Arc::new(ApiClient::new("http://api.invalid", "proxy-key").expect("client builds")),
        reported,
    ))
    .start(BOX_ID.to_string())
}

#[tokio::test]
async fn carries_http_to_a_guest_port_over_the_runner_tunnel() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
    let address = listener.local_addr().expect("has an address").to_string();
    let runner = tokio::spawn(fake_runner(listener));

    let clients = seeded_clients(address).await;

    let request = http::Request::builder()
        .method(http::Method::GET)
        .uri(format!("http://{PREVIEW_HOST}/hello?value=ok"))
        // Forged forwarding headers: the proxy must replace, not relay, these.
        .header("x-forwarded-for", "198.51.100.9")
        .header("x-real-ip", "198.51.100.9")
        // A hop-by-hop header plus a header it names, both of which must be dropped.
        .header("connection", "keep-alive, x-internal-token")
        .header("x-internal-token", "must-not-leak")
        .header("accept", "text/plain")
        .body(Empty::<bytes::Bytes>::new())
        .expect("valid request");

    let target = RequestTarget {
        uri: format!("http://{BOX_ID}:3000/hello")
            .parse()
            .expect("valid target"),
        host: PREVIEW_HOST.to_string(),
        headers: vec![(
            HeaderName::from_static("x-forwarded-proto"),
            HeaderValue::from_static("https"),
        )],
        upstream: Upstream::Guest,
    };

    let response = forward(
        request,
        target,
        &clients,
        Some("203.0.113.7"),
        quiet_activity().await,
    )
    .await
    .expect("request is forwarded");

    assert_eq!(response.status(), 200);
    let received = response
        .into_body()
        .collect()
        .await
        .expect("body reads")
        .to_bytes();
    assert_eq!(&received[..], b"through-l4-ok");

    let observed = runner.await.expect("runner task");

    assert_eq!(
        observed.connect_line,
        format!("CONNECT /v1/boxes/{BOX_ID}/network/tunnel?port=3000 HTTP/1.1"),
        "the tunnel is opened for the box and port from the hostname"
    );
    assert!(
        observed
            .connect_headers
            .iter()
            .any(|header| header == "X-BoxLite-Authorization: Bearer runner-key"),
        "the runner key authenticates the tunnel: {:?}",
        observed.connect_headers
    );

    assert_eq!(
        observed.guest_line, "GET /hello?value=ok HTTP/1.1",
        "the client's path and query reach the guest unchanged"
    );

    let header = |name: &str| {
        observed
            .guest_headers
            .iter()
            .find(|header| {
                header
                    .to_ascii_lowercase()
                    .starts_with(&format!("{name}: "))
            })
            .map(|header| header[name.len() + 2..].to_string())
    };

    assert_eq!(
        header("host").as_deref(),
        Some(PREVIEW_HOST),
        "the guest sees the preview hostname, not the box ID it was dialled by"
    );
    assert_eq!(
        header("x-forwarded-for").as_deref(),
        Some("203.0.113.7"),
        "the client's forged X-Forwarded-For must be replaced"
    );
    assert_eq!(header("x-forwarded-proto").as_deref(), Some("https"));
    assert_eq!(
        header("x-real-ip"),
        None,
        "forged X-Real-IP must be dropped"
    );
    assert_eq!(
        header("x-internal-token"),
        None,
        "a header named by Connection must be dropped"
    );
    assert_eq!(header("accept").as_deref(), Some("text/plain"));
}

#[tokio::test]
async fn reports_a_failed_tunnel_as_bad_gateway() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Bind and immediately drop, so the address refuses connections.
    let address = {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
        listener.local_addr().expect("has an address").to_string()
    };

    let clients = seeded_clients(address).await;
    let request = http::Request::builder()
        .uri(format!("http://{PREVIEW_HOST}/hello"))
        .body(body::empty())
        .expect("valid request");

    let error = forward(
        request,
        RequestTarget {
            uri: format!("http://{BOX_ID}:3000/hello")
                .parse()
                .expect("valid target"),
            host: PREVIEW_HOST.to_string(),
            headers: Vec::new(),
            upstream: Upstream::Guest,
        },
        &clients,
        None,
        quiet_activity().await,
    )
    .await
    .expect_err("an unreachable runner is an error");

    assert_eq!(error.status(), http::StatusCode::BAD_GATEWAY);
}
