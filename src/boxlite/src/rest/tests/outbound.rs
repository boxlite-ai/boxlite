use super::*;
use crate::litebox::NetworkHandle;
use crate::rest::{litebox::RestBox, options::BoxliteRestOptions, types::BoxResponse};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn network_at(url: String) -> NetworkHandle {
    let client = ApiClient::new(&BoxliteRestOptions::new(url)).unwrap();
    let info: BoxResponse = serde_json::from_value(serde_json::json!({
        "box_id":"policy-box", "name":null, "status":"running",
        "created_at":"2026-07-14T00:00:00Z", "updated_at":"2026-07-14T00:00:00Z",
        "pid":null, "image":"alpine:latest", "cpus":1, "memory_mib":512
    }))
    .unwrap();
    NetworkHandle::new(Arc::new(RestBox::new(client, info.to_box_info().unwrap())))
}

async fn peer(
    status: u16,
    headers: &str,
    body: &str,
) -> (NetworkHandle, tokio::task::JoinHandle<(String, String)>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let handle = network_at(format!("http://{}", listener.local_addr().unwrap()));
    let response = format!(
        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    );
    let server = tokio::spawn(async move {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                assert!(head.len() < 16 << 10);
                head.push(stream.read_u8().await.unwrap());
            }
            let head = String::from_utf8(head).unwrap();
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            assert!(length < 64 << 10);
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await.unwrap();
            stream.write_all(response.as_bytes()).await.unwrap();
            (head, String::from_utf8(body).unwrap())
        })
        .await
        .unwrap()
    });
    (handle, server)
}

fn replacement() -> OutboundReplacement {
    OutboundReplacement::new(
        OutboundRevision::parse("rev-a").unwrap(),
        OutboundSnapshot {
            policy: OutboundNetworkConfig::default(),
            revision: OutboundRevision::parse("rev-b").unwrap(),
        },
    )
    .unwrap()
}

#[tokio::test]
async fn outbound_rest_legacy_update_omits_the_conditional_header() {
    let (handle, server) = peer(204, "", "").await;
    let policy = OutboundNetworkConfig::default();
    handle.update_outbound(policy.clone()).await.unwrap();
    let (head, body) = server.await.unwrap();
    assert!(head.starts_with("PUT /v1/boxes/policy-box/network/outbound HTTP/1.1\r\n"));
    assert!(!head.to_ascii_lowercase().contains("\r\nif-match:"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        serde_json::to_value(policy).unwrap()
    );
}

#[tokio::test]
async fn outbound_rest_total_timeout_includes_a_stalled_acknowledgement_body() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let handle = network_at(format!("http://{}", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nETag: \"rev-b\"\r\nContent-Length: 100\r\n\r\n")
            .await
            .unwrap();
        std::future::pending::<()>().await;
        drop(stream);
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(13),
        handle.replace_outbound_snapshot(replacement()),
    )
    .await;
    server.abort();
    let _ = server.await;
    let error = result
        .expect("outbound exchange exceeded its total bound")
        .unwrap_err();
    assert!(matches!(error, BoxliteError::Network(_)));
    assert!(
        error.to_string().to_ascii_lowercase().contains("timed out"),
        "{error}"
    );
}

#[tokio::test]
async fn outbound_rest_replacement_sends_metadata_outside_unchanged_policy_body() {
    let candidate = replacement();
    let body = serde_json::to_string(&candidate.candidate().policy).unwrap();
    let (handle, server) = peer(200, "ETag: \"rev-b\"\r\n", &body).await;
    assert_eq!(
        handle.replace_outbound_snapshot(candidate).await.unwrap(),
        OutboundReplaceOutcome::Applied
    );
    let (head, body) = server.await.unwrap();
    let head = head.to_ascii_lowercase();
    assert!(head.starts_with("put /v1/boxes/policy-box/network/outbound/snapshot http/1.1\r\n"));
    assert!(head.contains("\r\nif-match: \"rev-a\"\r\n"));
    assert!(head.contains("\r\nx-boxlite-outbound-revision: rev-b\r\n"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"mode":"enabled","allow_net":[]})
    );
}

#[tokio::test]
async fn outbound_rest_rejects_unconfirmed_acknowledgements_and_old_peers() {
    for (status, headers, body) in [
        (200, "", r#"{"mode":"enabled"}"#),
        (200, "ETag: W/\"rev-b\"\r\n", r#"{"mode":"enabled"}"#),
        (200, "ETag: \"wrong\"\r\n", r#"{"mode":"enabled"}"#),
        (
            200,
            "ETag: \"rev-b\"\r\nETag: \"rev-b\"\r\n",
            r#"{"mode":"enabled"}"#,
        ),
        (200, "ETag: \"rev-b\"\r\n", r#"{"mode":"disabled"}"#),
        (200, "ETag: \"rev-b\"\r\n", "invalid-json"),
        (201, "ETag: \"rev-b\"\r\n", r#"{"mode":"enabled"}"#),
    ] {
        let (handle, server) = peer(status, headers, body).await;
        assert!(
            handle
                .replace_outbound_snapshot(replacement())
                .await
                .is_err(),
            "accepted {status} / {headers} / {body}"
        );
        assert!(
            server
                .await
                .unwrap()
                .0
                .starts_with("PUT /v1/boxes/policy-box/network/outbound/snapshot ")
        );
    }
    for status in [404, 405, 501] {
        let (handle, server) = peer(status, "", "old server").await;
        assert!(matches!(
            handle.replace_outbound_snapshot(replacement()).await,
            Err(BoxliteError::Unsupported(_))
        ));
        server.await.unwrap();
    }
    let (handle, server) = peer(412, "", "stale").await;
    assert_eq!(
        handle
            .replace_outbound_snapshot(replacement())
            .await
            .unwrap(),
        OutboundReplaceOutcome::PreconditionFailed
    );
    server.await.unwrap();
}

#[tokio::test]
async fn outbound_rest_snapshot_reads_policy_and_strong_etag() {
    let (handle, server) = peer(
        200,
        "ETag: \"rev-a\"\r\n",
        r#"{"mode":"enabled","allow_net":["example.com"]}"#,
    )
    .await;
    let snapshot = handle.outbound_snapshot().await.unwrap();
    assert_eq!(snapshot.revision.as_str(), "rev-a");
    assert_eq!(snapshot.policy.allow_net, ["example.com"]);
    assert!(
        server
            .await
            .unwrap()
            .0
            .starts_with("GET /v1/boxes/policy-box/network/outbound ")
    );
    let (handle, server) = peer(
        200,
        "ETag: \"rev-a\"\r\n",
        r#"{"mode":"disabled","allow_net":["example.com"]}"#,
    )
    .await;
    assert!(handle.outbound_snapshot().await.is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn outbound_rest_status_preserves_uncertainty_and_validates_confirmation() {
    let policy = serde_json::json!({"mode":"enabled","allow_net":[]});
    for (phase, pending, observed_revision, observed_phase, succeeds) in [
        ("confirmed", None, "rev-a", "confirmed", true),
        ("uncertain", Some("rev-b"), "rev-a", "confirmed", true),
        ("pending", Some("rev-b"), "rev-b", "pending", true),
        ("confirmed", Some("rev-b"), "rev-a", "confirmed", false),
        ("confirmed", None, "rev-b", "confirmed", false),
        ("confirmed", None, "rev-a", "pending", false),
    ] {
        let body = serde_json::json!({
            "persisted":{"policy":policy,"revision":"rev-a"},
            "observed":{"policy":policy,"revision":observed_revision,"application_state":observed_phase},
            "application_state":phase,"pending_revision":pending
        }).to_string();
        let (handle, server) = peer(200, "", &body).await;
        let status = handle.outbound_status().await;
        assert_eq!(status.is_ok(), succeeds, "{body}: {status:?}");
        if let Ok(status) = status {
            assert_eq!(
                serde_json::to_value(status).unwrap()["application_state"],
                phase
            );
        }
        assert!(
            server
                .await
                .unwrap()
                .0
                .starts_with("GET /v1/boxes/policy-box/network/outbound/status ")
        );
    }
    let (handle, server) = peer(200, "", r#"{"mode":"enabled"}"#).await;
    assert!(
        handle.outbound_status().await.is_err(),
        "old policy body is not versioned status"
    );
    server.await.unwrap();
}
