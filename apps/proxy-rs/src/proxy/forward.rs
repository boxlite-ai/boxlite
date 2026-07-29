// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The reverse-proxy engine: rewrite a request onto a target, relay the
//! response, and hand off the socket when the two ends negotiate an upgrade.

use std::time::Duration;

use http::header::{CONNECTION, HOST, HeaderName, HeaderValue, UPGRADE};
use http::{HeaderMap, Request, Response, StatusCode, Uri};

use crate::body::{self, Body};
use crate::error::{ProxyError, Result};

use super::upstream::{Clients, Upstream};

/// A box may legitimately take minutes to answer (a cold server, a long
/// computation), but not forever.
const RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(300);

/// Headers that describe a single hop and must not be relayed to the next one.
const HOP_BY_HOP: [HeaderName; 7] = [
    http::header::CONNECTION,
    http::header::PROXY_AUTHENTICATE,
    http::header::PROXY_AUTHORIZATION,
    http::header::TE,
    http::header::TRAILER,
    http::header::TRANSFER_ENCODING,
    http::header::UPGRADE,
];

/// Where a request is going and what it should look like when it gets there.
pub struct RequestTarget {
    pub uri: Uri,
    /// The `Host` the target should see, which is not the host we dial: a guest
    /// port is dialled by box ID but must see the preview hostname.
    pub host: String,
    pub headers: Vec<(HeaderName, HeaderValue)>,
    pub upstream: Upstream,
}

/// Generic over the request body so the rewriting rules can be exercised without
/// a live connection to produce a `hyper::body::Incoming`.
pub async fn forward<B>(
    mut request: Request<B>,
    target: RequestTarget,
    clients: &Clients,
    client_ip: Option<&str>,
    activity: super::activity::ActivityHandle,
) -> Result<Response<Body>>
where
    B: hyper::body::Body<Data = bytes::Bytes> + Send + Sync + 'static,
    B::Error: Into<crate::body::BoxError>,
{
    let upgrade_protocol = requested_upgrade(request.headers());
    let client_upgrade = upgrade_protocol
        .is_some()
        .then(|| hyper::upgrade::on(&mut request));

    let uri = rewrite_uri(&target.uri, request.uri())?;
    let (parts, inbound_body) = request.into_parts();
    let mut headers = parts.headers;

    strip_hop_by_hop(&mut headers);
    // Re-stated from what the client actually sent, so a client cannot forge its
    // own origin by presenting these itself.
    for forwarded in [
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-port",
        "x-real-ip",
    ] {
        headers.remove(forwarded);
    }
    if let Some(client_ip) = client_ip.and_then(|ip| HeaderValue::from_str(ip).ok()) {
        headers.insert(HeaderName::from_static("x-forwarded-for"), client_ip);
    }
    if let Some(protocol) = &upgrade_protocol {
        headers.insert(CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(UPGRADE, protocol.clone());
    }
    for (name, value) in target.headers {
        headers.insert(name, value);
    }
    if let Ok(host) = HeaderValue::from_str(&target.host) {
        headers.insert(HOST, host);
    }

    let mut outbound = Request::builder()
        .method(parts.method)
        .uri(uri)
        .body(body::relay(inbound_body))
        .map_err(|err| ProxyError::internal(format!("failed to build upstream request: {err}")))?;
    *outbound.headers_mut() = headers;

    let mut response = tokio::time::timeout(
        RESPONSE_HEADER_TIMEOUT,
        clients.send(target.upstream, outbound),
    )
    .await
    .map_err(|_| bad_gateway("upstream did not respond in time"))?
    .map_err(|err| bad_gateway(format!("upstream request failed: {err}")))?;

    if let (StatusCode::SWITCHING_PROTOCOLS, Some(client_upgrade)) =
        (response.status(), client_upgrade)
    {
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        // The upgraded socket outlives this response, and so must the activity
        // reporter keeping the box awake.
        let activity = activity.clone();
        tokio::spawn(async move {
            splice(client_upgrade, upstream_upgrade).await;
            drop(activity);
        });
    }

    let (mut parts, upstream_body) = response.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    if parts.status == StatusCode::SWITCHING_PROTOCOLS {
        // The upgrade headers are the one case where a hop-by-hop header is the
        // payload, so they go back in after stripping.
        parts
            .headers
            .insert(CONNECTION, HeaderValue::from_static("upgrade"));
        if let Some(protocol) = upgrade_protocol {
            parts.headers.insert(UPGRADE, protocol);
        }
    }

    Ok(Response::from_parts(
        parts,
        body::guarded(body::stream(upstream_body), activity),
    ))
}

/// Pumps bytes between the two upgraded connections until either side closes.
async fn splice(client: hyper::upgrade::OnUpgrade, upstream: hyper::upgrade::OnUpgrade) {
    let (client, upstream) = match tokio::try_join!(client, upstream) {
        Ok(ends) => ends,
        Err(err) => {
            tracing::warn!(error = %err, "upgrade handshake failed");
            return;
        }
    };

    let mut client = hyper_util::rt::TokioIo::new(client);
    let mut upstream = hyper_util::rt::TokioIo::new(upstream);
    if let Err(err) = tokio::io::copy_bidirectional(&mut client, &mut upstream).await {
        tracing::debug!(error = %err, "upgraded stream closed with an error");
    }
}

/// Points the request at the target while keeping the client's own query string.
fn rewrite_uri(target: &Uri, inbound: &Uri) -> Result<Uri> {
    let target_query = target.query().unwrap_or_default();
    let inbound_query = inbound.query().unwrap_or_default();
    let query = match (target_query.is_empty(), inbound_query.is_empty()) {
        (false, false) => format!("{target_query}&{inbound_query}"),
        _ => format!("{target_query}{inbound_query}"),
    };

    let authority = target
        .authority()
        .ok_or_else(|| ProxyError::internal("target URL has no host"))?;
    let scheme = target.scheme_str().unwrap_or("http");
    let separator = if query.is_empty() { "" } else { "?" };

    format!("{scheme}://{authority}{}{separator}{query}", target.path())
        .parse()
        .map_err(|err| ProxyError::internal(format!("failed to build upstream URL: {err}")))
}

/// The protocol the client wants to switch to, if it asked to switch at all.
fn requested_upgrade(headers: &HeaderMap) -> Option<HeaderValue> {
    let asked_to_upgrade = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        });

    asked_to_upgrade
        .then(|| headers.get(UPGRADE).cloned())
        .flatten()
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let listed: Vec<HeaderName> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|token| HeaderName::from_bytes(token.trim().as_bytes()).ok())
        .collect();

    for name in listed {
        headers.remove(&name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
    headers.remove("keep-alive");
    headers.remove("proxy-connection");
}

fn bad_gateway(message: impl std::fmt::Display) -> ProxyError {
    ProxyError::Upstream {
        status: StatusCode::BAD_GATEWAY,
        message: message.to_string(),
        code: "BAD_GATEWAY".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(
                HeaderName::from_bytes(name.as_bytes()).expect("valid name"),
                HeaderValue::from_str(value).expect("valid value"),
            );
        }
        headers
    }

    #[test]
    fn keeps_the_client_query_string() {
        let uri = rewrite_uri(
            &"http://AbCdEf123456:3000/hello".parse().unwrap(),
            &"http://3000-box.proxy.test/hello?value=ok".parse().unwrap(),
        )
        .expect("rewrites");

        assert_eq!(uri.to_string(), "http://AbCdEf123456:3000/hello?value=ok");
    }

    #[test]
    fn merges_a_query_the_target_already_carries() {
        let uri = rewrite_uri(
            &"https://runner.test/boxes/b/toolbox/proxy/22222/x?a=1"
                .parse()
                .unwrap(),
            &"http://proxy.test/x?b=2".parse().unwrap(),
        )
        .expect("rewrites");

        assert_eq!(uri.query(), Some("a=1&b=2"));
    }

    #[test]
    fn preserves_percent_escapes_in_the_target_path() {
        let uri = rewrite_uri(
            &"http://box:3000/files/a%2Fb".parse().unwrap(),
            &"http://proxy.test/files/a%2Fb".parse().unwrap(),
        )
        .expect("rewrites");

        assert_eq!(uri.path(), "/files/a%2Fb");
    }

    #[test]
    fn drops_hop_by_hop_headers_including_those_named_by_connection() {
        let mut map = headers(&[
            ("connection", "keep-alive, x-internal-token"),
            ("keep-alive", "timeout=5"),
            ("x-internal-token", "secret"),
            ("transfer-encoding", "chunked"),
            ("proxy-connection", "keep-alive"),
            ("content-type", "text/plain"),
        ]);

        strip_hop_by_hop(&mut map);

        assert_eq!(map.get("content-type").unwrap(), "text/plain");
        for dropped in [
            "connection",
            "keep-alive",
            "x-internal-token",
            "transfer-encoding",
            "proxy-connection",
        ] {
            assert!(map.get(dropped).is_none(), "{dropped} should be stripped");
        }
    }

    #[test]
    fn detects_a_websocket_upgrade_but_not_a_plain_request() {
        let websocket = headers(&[("connection", "Upgrade"), ("upgrade", "websocket")]);
        assert_eq!(requested_upgrade(&websocket).unwrap(), "websocket");

        let with_other_tokens = headers(&[
            ("connection", "keep-alive, Upgrade"),
            ("upgrade", "websocket"),
        ]);
        assert_eq!(requested_upgrade(&with_other_tokens).unwrap(), "websocket");

        assert!(requested_upgrade(&headers(&[("connection", "keep-alive")])).is_none());
        // "Upgrade:" without the Connection token is not an upgrade request.
        assert!(requested_upgrade(&headers(&[("upgrade", "websocket")])).is_none());
    }
}
