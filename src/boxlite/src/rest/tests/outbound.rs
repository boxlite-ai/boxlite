use super::*;
use crate::litebox::NetworkHandle;
use crate::rest::{litebox::RestBox, options::BoxliteRestOptions, types::BoxResponse};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MANAGED_CAPABILITY: &str = r#"{"capabilities":{"outbound_proxy_registry_enabled":true}}"#;
const BOUND_POLICY: &str =
    r#"{"mode":"enabled","allow_net":["packages.example"],"proxy":"build-egress"}"#;

async fn exchange(listener: &tokio::net::TcpListener, response: &str) -> (String, String) {
    let (stream, _) = listener.accept().await.unwrap();
    exchange_stream(stream, response).await
}

async fn exchange_stream(
    mut stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    response: &str,
) -> (String, String) {
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
}

#[tokio::test]
async fn managed_proxy_registry_requires_tls_and_does_not_replay_credentials() {
    use crate::{OutboundProxyHandle, ProxyCredential, ProxyCredentialChange};
    use rustls::pki_types::PrivatePkcs8KeyDer;

    let rejected = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let plain_client = ApiClient::new(&BoxliteRestOptions::new(format!(
        "http://{}",
        rejected.local_addr().unwrap()
    )))
    .unwrap();
    let registry = OutboundProxyHandle(Arc::new(plain_client));
    let credential = ProxyCredential::new("username-marker", "password-marker").unwrap();
    let placeholder = format!("{credential:?}");
    assert!(!placeholder.contains("username-marker") && !placeholder.contains("password-marker"));
    assert!(
        registry
            .create("outbound", "https://proxy.example", Some(&credential))
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), rejected.accept())
            .await
            .is_err()
    );

    let rcgen::CertifiedKey { cert, key_pair } =
        rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivatePkcs8KeyDer::from(key_pair.serialize_der()).into(),
        )
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    let mut client =
        ApiClient::new(&BoxliteRestOptions::new(&url).with_path_prefix("default")).unwrap();
    client.trust_managed_test_peer(cert.der());
    let registry = OutboundProxyHandle(Arc::new(client));
    let redirect_to = rejected.local_addr().unwrap();
    let worker = tokio::spawn(async move {
        let mut writes = Vec::new();
        for (verb, status, headers, body) in [
            (
                "POST",
                201,
                String::new(),
                r#"{"credential":{"username":"username-marker","password":"password-marker"}}"#,
            ),
            ("PATCH", 200, String::new(), "malformed password-marker"),
            ("PATCH", 409, String::new(), "rejected username-marker"),
            (
                "PATCH",
                307,
                format!("Location: http://{redirect_to}/outside\r\n"),
                "",
            ),
            ("PATCH", 0, String::new(), ""),
        ] {
            for (prefix, status, headers, body) in [
                (
                    "GET /v1/config ".to_owned(),
                    200,
                    String::new(),
                    MANAGED_CAPABILITY,
                ),
                (
                    format!(
                        "{verb} /v1/default/proxies{} ",
                        if verb == "POST" { "" } else { "/outbound" }
                    ),
                    status,
                    headers,
                    body,
                ),
            ] {
                let response = if status == 0 {
                    String::new()
                } else {
                    format!(
                        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                        body.len()
                    )
                };
                let (head, body) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    let (stream, _) = listener.accept().await.unwrap();
                    let stream = acceptor.accept(stream).await.unwrap();
                    exchange_stream(stream, &response).await
                })
                .await
                .unwrap();
                assert!(head.starts_with(&prefix));
                if verb != "GET" && !body.is_empty() {
                    writes.push(serde_json::from_str::<serde_json::Value>(&body).unwrap());
                }
            }
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        writes
    });
    let results = [
        registry
            .create("outbound", "https://proxy.example", Some(&credential))
            .await
            .unwrap(),
        registry
            .update("outbound", None, ProxyCredentialChange::Keep)
            .await
            .unwrap(),
        registry
            .update(
                "outbound",
                Some("https://changed.example"),
                ProxyCredentialChange::Keep,
            )
            .await
            .unwrap(),
        registry
            .update("outbound", None, ProxyCredentialChange::Clear)
            .await
            .unwrap(),
        registry
            .update("outbound", None, ProxyCredentialChange::Set(credential))
            .await
            .unwrap(),
    ];
    assert_eq!(
        results.each_ref().map(|result| result.state),
        [
            ProxyMutationState::Accepted,
            ProxyMutationState::Accepted,
            ProxyMutationState::Rejected,
            ProxyMutationState::Unknown,
            ProxyMutationState::Unknown
        ]
    );
    assert!(!format!("{results:?}").contains("password-marker"));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), rejected.accept())
            .await
            .is_err()
    );
    let writes = worker.await.unwrap();
    assert!(
        writes[0]["credential"]["username"] == "username-marker"
            && writes[0]["credential"]["password"] == "password-marker"
    );
    assert_eq!(writes[1], serde_json::json!({}));
    assert_eq!(
        writes[2],
        serde_json::json!({"url":"https://changed.example"})
    );
    assert_eq!(writes[3], serde_json::json!({"credential":null}));
    assert!(writes[4]["credential"]["password"] == "password-marker");
}

async fn scripted_peer(
    replies: Vec<(u16, &'static str, &'static str)>,
) -> (String, tokio::task::JoinHandle<Vec<(String, String)>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, headers, body) in replies {
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                body.len(),
            );
            requests.push(
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    exchange(&listener, &response),
                )
                .await
                .unwrap(),
            );
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "unexpected additional request"
        );
        requests
    });
    (url, server)
}

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
            exchange(&listener, &response).await
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
async fn managed_proxy_retains_the_acknowledged_unbind_revision() {
    let confirmed = r#"{"persisted":{"revision":"rev-b","policy":{"mode":"enabled","allow_net":["packages.example"]}},"application_state":"confirmed","proxy":{"runtime_readback":"authenticated","installed":{"policy_revision":"rev-b","proxy":null}}}"#;
    let stale = r#"{"persisted":{"revision":"rev-b","policy":{"mode":"enabled"}},"application_state":"confirmed","proxy":{"runtime_readback":"authenticated","installed":{"policy_revision":"rev-a","proxy":null}}}"#;
    let missing_proxy = r#"{"persisted":{"revision":"rev-b","policy":{"mode":"enabled"}},"application_state":"confirmed","proxy":{"runtime_readback":"authenticated","installed":{"policy_revision":"rev-b"}}}"#;
    for (status, body, state) in [
        (200, confirmed, ProxyMutationState::Accepted),
        (200, stale, ProxyMutationState::AcceptedReleaseUnconfirmed),
        (
            200,
            missing_proxy,
            ProxyMutationState::AcceptedReleaseUnconfirmed,
        ),
        (503, "{}", ProxyMutationState::AcceptedReleaseUnconfirmed),
    ] {
        let (url, server) = scripted_peer(vec![
            (200, "", MANAGED_CAPABILITY),
            (200, "ETag: \"rev-a\"\r\n", BOUND_POLICY),
            (200, "ETag: \"rev-b\"\r\n", "{}"),
            (status, "", body),
        ])
        .await;
        let result = network_at(url).set_managed_proxy(None).await.unwrap();
        assert_eq!(result.state, state);
        assert_eq!(result.revision.unwrap().as_str(), "rev-b");
        let requests = server.await.unwrap();
        assert!(requests[0].0.starts_with("GET /v1/config "));
        assert!(
            requests[1]
                .0
                .starts_with("GET /v1/boxes/policy-box/network/outbound ")
        );
        assert!(
            requests[2]
                .0
                .starts_with("PUT /v1/boxes/policy-box/network/outbound ")
        );
        assert!(requests[2].0.contains("\r\nif-match: \"rev-a\"\r\n"));
        assert!(!requests[2].0.contains("x-boxlite-outbound-revision"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&requests[2].1).unwrap(),
            serde_json::json!({"mode":"enabled", "allow_net":["packages.example"], "proxy":null})
        );
        assert!(
            requests[3]
                .0
                .starts_with("GET /v1/boxes/policy-box/network/outbound/status ")
        );
    }
}

#[tokio::test]
async fn managed_proxy_distinguishes_conflicts_without_replaying() {
    for (status, body, state) in [
        (412, "{}", ProxyMutationState::Rejected),
        (
            409,
            r#"{"code":"outbound_update_blocked"}"#,
            ProxyMutationState::Rejected,
        ),
        (
            409,
            r#"{"code":"outbound_application_unconfirmed"}"#,
            ProxyMutationState::Unknown,
        ),
        (409, "{}", ProxyMutationState::Unknown),
    ] {
        let (url, server) = scripted_peer(vec![
            (200, "", MANAGED_CAPABILITY),
            (200, "ETag: \"rev-a\"\r\n", BOUND_POLICY),
            (status, "", body),
        ])
        .await;
        let result = network_at(url)
            .set_managed_proxy(Some("replacement"))
            .await
            .unwrap();
        assert_eq!(result.state, state);
        let requests = server.await.unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&requests[2].1).unwrap(),
            serde_json::json!({"mode":"enabled", "allow_net":["packages.example"], "proxy":"replacement"})
        );
    }
}

#[tokio::test]
async fn managed_proxy_refuses_unknown_policy_and_missing_capability_before_put() {
    for replies in [
        vec![(200, "", "{}")],
        vec![
            (200, "", MANAGED_CAPABILITY),
            (200, "ETag: W/\"rev-a\"\r\n", BOUND_POLICY),
        ],
        vec![
            (200, "", MANAGED_CAPABILITY),
            (
                200,
                "ETag: \"rev-a\"\r\n",
                r#"{"mode":"enabled","deny_net":["blocked.test"]}"#,
            ),
        ],
    ] {
        let (url, server) = scripted_peer(replies).await;
        assert!(network_at(url).set_managed_proxy(None).await.is_err());
        assert!(
            server
                .await
                .unwrap()
                .iter()
                .all(|(head, _)| head.starts_with("GET "))
        );
    }
}

#[tokio::test]
async fn managed_proxy_create_preserves_admission_and_optional_box_id() {
    use crate::{BoxOptions, BoxliteRuntime, ManagedCreateAdmission};
    for (proxy, status, body, expected, id) in [
        (
            Some("build-egress"),
            400,
            r#"{"code":"outbound_create_rejected"}"#,
            ManagedCreateAdmission::Rejected,
            None,
        ),
        (
            None,
            408,
            r#"{"code":"outbound_create_admitted","boxId":"admitted-box"}"#,
            ManagedCreateAdmission::Admitted,
            Some("admitted-box"),
        ),
        (
            None,
            400,
            r#"{"code":"outbound_create_admitted","boxId":1}"#,
            ManagedCreateAdmission::Admitted,
            None,
        ),
        (
            None,
            500,
            r#"{"box_id":"possible-box"}"#,
            ManagedCreateAdmission::Unknown,
            Some("possible-box"),
        ),
        (
            Some("build-egress"),
            201,
            r#"{"box_id":"created-box","status":["malformed"],"boxId":"alternate-box"}"#,
            ManagedCreateAdmission::Unknown,
            Some("created-box"),
        ),
        (
            None,
            502,
            r#"{"code":123,"boxId":"recovered-box"}"#,
            ManagedCreateAdmission::Unknown,
            Some("recovered-box"),
        ),
    ] {
        let (url, server) =
            scripted_peer(vec![(200, "", MANAGED_CAPABILITY), (status, "", body)]).await;
        let runtime =
            BoxliteRuntime::rest(BoxliteRestOptions::new(url).with_path_prefix("default")).unwrap();
        let result = runtime
            .create_with_managed_outbound_proxy(BoxOptions::default(), None, proxy)
            .await
            .err()
            .unwrap();
        assert_eq!(result.admission, expected);
        assert_eq!(result.http_status, Some(status));
        assert_eq!(result.box_id.as_ref().map(|id| id.as_str()), id);
        let requests = server.await.unwrap();
        assert!(requests[0].0.starts_with("GET /v1/config "));
        assert!(requests[1].0.starts_with("POST /v1/default/boxes "));
        let body: serde_json::Value = serde_json::from_str(&requests[1].1).unwrap();
        assert_eq!(
            body.pointer("/network/outbound/proxy"),
            Some(&serde_json::json!(proxy))
        );
    }
}

#[tokio::test]
async fn managed_proxy_create_returns_box_on_valid_acknowledgement() {
    use crate::{BoxOptions, BoxliteRuntime};
    let box_body = r#"{"box_id":"created-box","status":"running","created_at":"","updated_at":"","image":"alpine","cpus":1,"memory_mib":512}"#;
    let (url, server) =
        scripted_peer(vec![(200, "", MANAGED_CAPABILITY), (201, "", box_body)]).await;
    let runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(url).with_path_prefix("default")).unwrap();
    let box_handle = runtime
        .create_with_managed_outbound_proxy(BoxOptions::default(), None, Some("build-egress"))
        .await
        .unwrap();
    assert_eq!(box_handle.id().as_str(), "created-box");
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].0.starts_with("POST /v1/default/boxes "));
}

#[tokio::test]
async fn outbound_rest_snapshot_accepts_cloud_proxy_selection() {
    let (handle, server) = peer(
        200,
        "ETag: \"rev-a\"\r\n",
        r#"{"mode":"enabled","allow_net":["packages.example"],"proxy":"build-egress"}"#,
    )
    .await;

    let snapshot = handle.outbound_snapshot().await;
    let (request, _) = server.await.unwrap();

    assert!(request.starts_with("GET /v1/boxes/policy-box/network/outbound "));
    let snapshot = snapshot.expect("Cloud policy with a proxy must remain readable");
    assert_eq!(snapshot.revision.as_str(), "rev-a");
    assert_eq!(snapshot.policy.allow_net, ["packages.example"]);
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
