use super::*;
use crate::net::{
    OutboundApplicationState, OutboundReplaceOutcome, OutboundReplacement, OutboundRevision,
    OutboundSnapshot,
};
use crate::runtime::options::OutboundNetworkConfig;

struct WireRequest {
    headers: String,
    body: String,
}

fn control_peer(
    status: u16,
    headers: &str,
    body: &str,
) -> (
    tempfile::TempDir,
    GvproxyBackend,
    tokio::task::JoinHandle<WireRequest>,
) {
    let dir = tempfile::Builder::new()
        .prefix("bl-outbound-")
        .tempdir_in("/tmp")
        .unwrap();
    let config = NetworkBackendConfig {
        outbound_disabled: false,
        socket_path: dir.path().join("net.sock"),
        allow_net: vec![],
        secrets: vec![],
        ca_dir: dir.path().to_path_buf(),
        rate_limit: Default::default(),
    };
    let backend = GvproxyBackend::from_config(&config);
    let listener = tokio::net::UnixListener::bind(&backend.control_socket_path).unwrap();
    let response = format!(
        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    );
    let server = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                assert!(headers.len() < 4096, "unbounded request headers");
                headers.push(conn.read_u8().await.unwrap());
            }
            let headers = String::from_utf8(headers).unwrap();
            let size = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            assert!(size <= 64 << 10);
            let mut body = vec![0; size];
            conn.read_exact(&mut body).await.unwrap();
            conn.write_all(response.as_bytes()).await.unwrap();
            WireRequest {
                headers,
                body: String::from_utf8(body).unwrap(),
            }
        })
        .await
        .expect("bounded control exchange")
    });
    (dir, backend, server)
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
async fn outbound_snapshot_propagates_shared_restoration_identity() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/outbound/contract-v1.json"
    )))
    .unwrap();
    let example = fixture["replacement_cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "conditional-restoration")
        .unwrap();
    let candidate = example["candidate_revision"].as_str().unwrap();
    let expected = example["compensation_expected_revision"].as_str().unwrap();
    let restoration = example["restoration_revision"].as_str().unwrap();
    assert_eq!(expected, candidate);
    assert_ne!(restoration, example["expected_revision"].as_str().unwrap());
    let replacement = OutboundReplacement::new(
        OutboundRevision::parse(expected).unwrap(),
        OutboundSnapshot {
            policy: OutboundNetworkConfig::default(),
            revision: OutboundRevision::parse(restoration).unwrap(),
        },
    )
    .unwrap();
    let (_dir, backend, server) = control_peer(
        200,
        &format!("ETag: \"{restoration}\"\r\n"),
        r#"{"mode":"enabled","allow_net":[]}"#,
    );
    assert_eq!(
        backend
            .replace_outbound_snapshot(&replacement)
            .await
            .unwrap(),
        OutboundReplaceOutcome::Applied
    );
    let request = server.await.unwrap();
    let headers = request.headers.to_ascii_lowercase();
    assert!(headers.contains(&format!("\r\nif-match: \"{expected}\"\r\n")));
    assert!(headers.contains(&format!(
        "\r\nx-boxlite-outbound-revision: {restoration}\r\n"
    )));
}

#[test]
fn outbound_revision_rejects_untrusted_metadata_and_validates_candidates() {
    for token in [
        "".into(),
        "a".repeat(129),
        "a\r\nInjected: yes".into(),
        "\"tag\"".into(),
        "white space".into(),
        "版本".into(),
    ] {
        assert!(
            OutboundRevision::parse(&token).is_err(),
            "accepted {token:?}"
        );
        assert!(serde_json::from_value::<OutboundRevision>(Value::String(token)).is_err());
    }
    for token in [
        "initial".to_string(),
        "a".repeat(128),
        "ABC_123-def".to_string(),
    ] {
        let revision = OutboundRevision::parse(&token).unwrap();
        assert_eq!(serde_json::to_value(&revision).unwrap(), token);
        assert_eq!(
            serde_json::from_value::<OutboundRevision>(Value::String(token)).unwrap(),
            revision
        );
    }
    for candidate in ["initial", "rev-a"] {
        let mut snapshot = replacement().candidate().clone();
        snapshot.revision = OutboundRevision::parse(candidate).unwrap();
        assert!(
            OutboundReplacement::new(OutboundRevision::parse("rev-a").unwrap(), snapshot).is_err()
        );
    }
    let mut snapshot = replacement().candidate().clone();
    snapshot.policy.allow_net = vec!["invalid host".into()];
    assert!(OutboundReplacement::new(OutboundRevision::parse("rev-a").unwrap(), snapshot).is_err());
}

#[tokio::test]
async fn outbound_snapshot_update_sends_exact_revision_headers_and_policy_only() {
    let (_dir, backend, server) = control_peer(
        200,
        "ETag: \"rev-b\"\r\n",
        r#"{"mode":"enabled","allow_net":[]}"#,
    );
    assert_eq!(
        backend
            .replace_outbound_snapshot(&replacement())
            .await
            .unwrap(),
        OutboundReplaceOutcome::Applied
    );
    let request = server.await.unwrap();
    let headers = request.headers.to_ascii_lowercase();
    assert!(headers.starts_with("put /network/outbound/snapshot http/1.1\r\n"));
    assert!(headers.contains("\r\nif-match: \"rev-a\"\r\n"));
    assert!(headers.contains("\r\nx-boxlite-outbound-revision: rev-b\r\n"));
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        serde_json::json!({"mode":"enabled", "allow_net":[]})
    );
}

#[tokio::test]
async fn outbound_snapshot_update_requires_matching_acknowledgement() {
    let policy = r#"{"mode":"enabled","allow_net":[]}"#;
    for (headers, body) in [
        ("", policy),
        ("ETag: \"rev-other\"\r\n", policy),
        ("ETag: W/\"rev-b\"\r\n", policy),
        ("ETag: rev-b\r\n", policy),
        ("ETag: \"rev-b\"\r\nETag: \"rev-b\"\r\n", policy),
        (
            "ETag: \"rev-b\"\r\n",
            r#"{"mode":"disabled","allow_net":[]}"#,
        ),
        (
            "ETag: \"rev-b\"\r\n",
            r#"{"mode":"enabled","revision":"rev-b"}"#,
        ),
        ("ETag: \"rev-b\"\r\n", ""),
        ("ETag: \"rev-b\"\r\n", "not json"),
    ] {
        let (_dir, backend, server) = control_peer(200, headers, body);
        let error = backend
            .replace_outbound_snapshot(&replacement())
            .await
            .unwrap_err();
        assert!(matches!(error, BoxliteError::Network(_)), "{error}");
        assert!(error.to_string().contains("uncertain"), "{error}");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn outbound_snapshot_update_distinguishes_precondition_and_old_backend_without_fallback() {
    for status in [404, 405, 412, 500, 204] {
        let (_dir, backend, server) = control_peer(status, "", "");
        let result = backend.replace_outbound_snapshot(&replacement()).await;
        match status {
            404 | 405 => assert!(matches!(result, Err(BoxliteError::Unsupported(_)))),
            412 => assert_eq!(result.unwrap(), OutboundReplaceOutcome::PreconditionFailed),
            _ => assert!(matches!(result, Err(BoxliteError::Network(_)))),
        }
        let request = server.await.unwrap();
        assert!(
            request
                .headers
                .starts_with("PUT /network/outbound/snapshot HTTP/1.1\r\n")
        );
    }
}

#[tokio::test]
async fn outbound_snapshot_status_preserves_application_phase() {
    for (phase, expected) in [
        ("pending", OutboundApplicationState::Pending),
        ("confirmed", OutboundApplicationState::Confirmed),
        ("uncertain", OutboundApplicationState::Uncertain),
    ] {
        let body = serde_json::json!({"policy":{"mode":"enabled","allow_net":[]}, "revision":"rev-b", "application_state":phase, "capabilities":["revision-v1"]}).to_string();
        let (_dir, backend, server) = control_peer(200, "", &body);
        let observed = backend.outbound_snapshot().await.unwrap();
        assert_eq!(observed.application_state, expected);
        assert_eq!(observed.snapshot.revision.as_str(), "rev-b");
        assert!(
            server
                .await
                .unwrap()
                .headers
                .starts_with("GET /network/outbound/status HTTP/1.1\r\n")
        );
    }
}

#[tokio::test]
async fn outbound_snapshot_status_rejects_missing_capabilities_and_invalid_identity_or_policy() {
    let valid = serde_json::json!({"policy":{"mode":"enabled","allow_net":[]}, "revision":"rev-b", "application_state":"confirmed", "capabilities":["revision-v1"]});
    for (field, invalid) in [
        ("revision", Value::String("bad token".into())),
        ("revision", Value::Null),
        ("application_state", Value::String("failed".into())),
        ("application_state", Value::Null),
        ("capabilities", serde_json::json!([])),
        ("capabilities", Value::Null),
        (
            "policy",
            serde_json::json!({"mode":"enabled", "allow_net":["bad host"]}),
        ),
        (
            "policy",
            serde_json::json!({"mode":"enabled", "proxy":"unsupported"}),
        ),
    ] {
        let mut body = valid.clone();
        body[field] = invalid;
        let (_dir, backend, server) = control_peer(200, "", &body.to_string());
        assert!(
            backend.outbound_snapshot().await.is_err(),
            "accepted invalid {field}"
        );
        server.await.unwrap();
    }
    for status in [404, 405] {
        let (_dir, backend, server) = control_peer(status, "", "old backend");
        assert!(matches!(
            backend.outbound_snapshot().await,
            Err(BoxliteError::Unsupported(_))
        ));
        server.await.unwrap();
    }
}
