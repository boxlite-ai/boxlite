//! Real serve HTTP routes and REST encoder, with a controlled upstream Runtime.
use super::*;
use axum::http::{HeaderMap, Method};
use boxlite::net::{OutboundRevision, OutboundSnapshot};
use boxlite::runtime::options::OutboundNetworkConfig;

struct PeerState {
    current: OutboundSnapshot,
    calls: Vec<(String, HeaderMap, serde_json::Value)>,
    wrong_ack: bool,
    lookups: usize,
    advance_after_read: usize,
    pending_revision: Option<OutboundRevision>,
}

struct OutboundPeer {
    url: String,
    state: Arc<tokio::sync::Mutex<PeerState>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for OutboundPeer {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn peer_request(
    axum::extract::State(state): axum::extract::State<Arc<tokio::sync::Mutex<PeerState>>>,
    request: axum::extract::Request,
) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    let body = axum::body::to_bytes(request.into_body(), 64 << 10)
        .await
        .unwrap();
    let body: serde_json::Value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    let mut state = state.lock().await;
    if method == Method::GET && path == format!("/v1/boxes/{STUB_BOX_ID}") {
        state.lookups += 1;
        return Json(serde_json::json!({"box_id":STUB_BOX_ID,"name":STUB_BOX_NAME,"status":"running","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":1,"memory_mib":512})).into_response();
    }
    state
        .calls
        .push((format!("{method} {path}"), headers.clone(), body.clone()));
    if method == Method::GET && path.ends_with("/network/outbound/status") {
        let phase = if state.pending_revision.is_some() {
            "pending"
        } else {
            "confirmed"
        };
        let mut status = serde_json::json!({"persisted":state.current,"observed":{"policy":state.current.policy,"revision":state.current.revision,"application_state":phase},"application_state":phase});
        if let Some(revision) = &state.pending_revision {
            status["pending_revision"] = serde_json::json!(revision);
        }
        return Json(status).into_response();
    }
    if method == Method::GET && path.ends_with("/network/outbound") {
        let snapshot = state.current.clone();
        if state.advance_after_read > 0 {
            state.current.revision =
                OutboundRevision::parse(format!("raced-{}", state.advance_after_read)).unwrap();
            state.advance_after_read -= 1;
        }
        return (
            [("etag", format!("\"{}\"", snapshot.revision))],
            Json(snapshot.policy),
        )
            .into_response();
    }
    if method == Method::PUT && path.ends_with("/network/outbound/snapshot") {
        if headers["if-match"] != format!("\"{}\"", state.current.revision) {
            return StatusCode::PRECONDITION_FAILED.into_response();
        }
        state.current = OutboundSnapshot {
            policy: serde_json::from_value(body).unwrap(),
            revision: OutboundRevision::parse(
                headers["x-boxlite-outbound-revision"].to_str().unwrap(),
            )
            .unwrap(),
        };
        let revision = if state.wrong_ack {
            "different-revision"
        } else {
            state.current.revision.as_str()
        };
        return (
            [("etag", format!("\"{revision}\""))],
            Json(state.current.policy.clone()),
        )
            .into_response();
    }
    if method == Method::PUT && path.ends_with("/network/outbound") {
        state.current.policy = serde_json::from_value(body).unwrap();
        return Json(serde_json::json!({})).into_response();
    }
    panic!("unexpected Runtime operation, including boot: {method} {path}");
}

async fn outbound_peer(api_key: Option<&str>) -> OutboundPeer {
    let peer = Arc::new(tokio::sync::Mutex::new(PeerState {
        current: OutboundSnapshot {
            policy: OutboundNetworkConfig::default(),
            revision: OutboundRevision::parse("rev-a").unwrap(),
        },
        calls: vec![],
        wrong_ack: false,
        lookups: 0,
        advance_after_read: 0,
        pending_revision: None,
    }));
    let app = Router::new()
        .fallback(peer_request)
        .with_state(peer.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut state = lifecycle_state();
    state.api_key = api_key.map(str::to_owned);
    state.runtime = BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(upstream)).unwrap();
    let (url, server) = serve_router(Arc::new(state)).await;
    OutboundPeer {
        url: format!("{url}/v1/boxes/{STUB_BOX_ID}/network/outbound"),
        state: peer,
        tasks: vec![task, server],
    }
}

#[tokio::test]
async fn outbound_serve_round_trip_keeps_policy_and_candidate_identity_separate() {
    let peer = outbound_peer(None).await;
    let client = reqwest::Client::new();
    let policy = client.get(&peer.url).send().await.unwrap();
    assert_eq!(policy.headers()["etag"], "\"rev-a\"");
    assert_eq!(
        policy.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"mode":"enabled","allow_net":[]})
    );
    let response = client
        .put(format!("{}/snapshot", peer.url))
        .header("if-match", "\"rev-a\"")
        .header("x-boxlite-outbound-revision", "rev-b")
        .json(&serde_json::json!({"mode":"disabled"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["etag"], "\"rev-b\"");
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"mode":"disabled","allow_net":[]})
    );
    let status: serde_json::Value = client
        .get(format!("{}/status", peer.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["persisted"]["revision"], "rev-b");
    assert_eq!(status["application_state"], "confirmed");
    assert_eq!(status["capabilities"], serde_json::json!(["revision-v1"]));
    assert_eq!(status["runtime_persisted"], status["persisted"]);
    assert!(status.get("pending_revision").is_none());
    assert!(status.get("observation_error").is_none());
    let state = peer.state.lock().await;
    let (_, headers, body) = state
        .calls
        .iter()
        .find(|(method, _, _)| method.starts_with("PUT"))
        .unwrap();
    assert_eq!(headers["if-match"], "\"rev-a\"");
    assert_eq!(headers["x-boxlite-outbound-revision"], "rev-b");
    assert_eq!(*body, serde_json::json!({"mode":"disabled","allow_net":[]}));
}

#[tokio::test]
async fn outbound_serve_public_preconditions_preserve_legacy_requests_and_reject_stale_writes() {
    let peer = outbound_peer(None).await;
    let client = reqwest::Client::new();
    let response = client
        .put(&peer.url)
        .json(&serde_json::json!({"mode":"enabled"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key("etag"));
    {
        let state = peer.state.lock().await;
        let (_, headers, body) = state
            .calls
            .iter()
            .find(|(method, _, _)| method.starts_with("PUT"))
            .unwrap();
        assert!(!headers.contains_key("if-match"));
        assert!(!headers.contains_key("x-boxlite-outbound-revision"));
        assert_eq!(*body, serde_json::json!({"mode":"enabled","allow_net":[]}));
    }
    let response = client
        .put(&peer.url)
        .header("if-match", r#"W/"old", "rev-a""#)
        .json(&serde_json::json!({"mode":"disabled"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let revision = response.headers()["etag"]
        .to_str()
        .unwrap()
        .trim_matches('"')
        .to_owned();
    assert_ne!(revision, "rev-a");
    OutboundRevision::parse(&revision).unwrap();
    let before = peer
        .state
        .lock()
        .await
        .calls
        .iter()
        .filter(|(method, _, _)| method.starts_with("PUT"))
        .count();
    for (value, expected) in [("\"rev-a\"", 412), ("\"rev-a\", invalid", 400)] {
        let response = client
            .put(&peer.url)
            .header("if-match", value)
            .json(&serde_json::json!({"mode":"enabled"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
    }
    let state = peer.state.lock().await;
    assert_eq!(state.current.revision.as_str(), revision);
    assert_eq!(
        state
            .calls
            .iter()
            .filter(|(method, _, _)| method.starts_with("PUT"))
            .count(),
        before
    );
}

#[tokio::test]
async fn outbound_serve_refuses_bad_metadata_and_mismatched_backend_ack() {
    let peer = outbound_peer(None).await;
    let client = reqwest::Client::new();
    for (expected, candidate) in [
        ("rev-a", "rev-b"),
        ("W/\"rev-a\"", "rev-b"),
        ("\"rev-a\"", "initial"),
        ("\"rev-a\"", "rev-a"),
        ("\"rev-a\"", "rev bad"),
    ] {
        let response = client
            .put(format!("{}/snapshot", peer.url))
            .header("if-match", expected)
            .header("x-boxlite-outbound-revision", candidate)
            .json(&serde_json::json!({"mode":"enabled"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    for duplicate in ["if-match", "x-boxlite-outbound-revision"] {
        let value = if duplicate == "if-match" {
            "\"rev-a\""
        } else {
            "rev-b"
        };
        let response = client
            .put(format!("{}/snapshot", peer.url))
            .header("if-match", "\"rev-a\"")
            .header("x-boxlite-outbound-revision", "rev-b")
            .header(duplicate, value)
            .json(&serde_json::json!({"mode":"enabled"}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "duplicate {duplicate}"
        );
    }
    for (name, value) in [
        ("if-match", "\"rev-a\""),
        ("x-boxlite-outbound-revision", "rev-b"),
    ] {
        let response = client
            .put(format!("{}/snapshot", peer.url))
            .header(name, value)
            .json(&serde_json::json!({"mode":"enabled"}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "incomplete metadata: {name}"
        );
    }
    let response = client
        .put(&peer.url)
        .header("x-boxlite-outbound-revision", "rev-b")
        .json(&serde_json::json!({"mode":"enabled"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(peer.state.lock().await.calls.is_empty());
    assert_eq!(peer.state.lock().await.lookups, 0);
    peer.state.lock().await.wrong_ack = true;
    let response = client
        .put(format!("{}/snapshot", peer.url))
        .header("if-match", "\"rev-a\"")
        .header("x-boxlite-outbound-revision", "rev-b")
        .json(&serde_json::json!({"mode":"enabled"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!response.headers().contains_key("etag"));
}

#[tokio::test]
async fn outbound_serve_control_resources_use_the_configured_bearer_boundary() {
    let peer = outbound_peer(Some("synthetic-control-key")).await;
    let client = reqwest::Client::new();
    let routes = [
        (Method::GET, ""),
        (Method::GET, "/status"),
        (Method::PUT, "/snapshot"),
    ];
    for authorization in [
        None,
        Some("Bearer wrong"),
        Some("Basic synthetic-control-key"),
        Some("Bearer "),
    ] {
        for (method, suffix) in &routes {
            let mut request = client
                .request(method.clone(), format!("{}{suffix}", peer.url))
                .header("if-match", "\"rev-a\"")
                .header("x-boxlite-outbound-revision", "rev-b")
                .json(&serde_json::json!({"mode":"disabled"}));
            if let Some(value) = authorization {
                request = request.header("authorization", value);
            }
            let response = request.send().await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {suffix}: {authorization:?}"
            );
        }
    }
    {
        let state = peer.state.lock().await;
        assert_eq!(state.lookups, 0, "denied requests cannot look up a Box");
        assert!(
            state.calls.is_empty(),
            "denied requests cannot reach control"
        );
    }
    for (method, suffix) in routes {
        let response = client
            .request(method.clone(), format!("{}{suffix}", peer.url))
            .bearer_auth("synthetic-control-key")
            .header("if-match", "\"rev-a\"")
            .header("x-boxlite-outbound-revision", "rev-b")
            .json(&serde_json::json!({"mode":"disabled"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{method} {suffix}");
    }
    let state = peer.state.lock().await;
    assert!(state.lookups > 0);
    assert_eq!(state.calls.len(), 3);
    assert_eq!(state.current.revision.as_str(), "rev-b");
    assert_eq!(
        state.current.policy.mode,
        boxlite::runtime::options::NetworkMode::Disabled
    );
}

#[tokio::test]
async fn outbound_serve_public_conditions_are_rechecked_after_a_rejected_cas() {
    for (condition, advances, expected_status, attempts) in [
        ("\"rev-a\"", 1, StatusCode::PRECONDITION_FAILED, 1),
        ("\"rev-a\", \"raced-1\"", 1, StatusCode::OK, 2),
        ("*", 1, StatusCode::OK, 2),
        ("*", 2, StatusCode::CONFLICT, 2),
    ] {
        let peer = outbound_peer(None).await;
        peer.state.lock().await.advance_after_read = advances;
        let response = reqwest::Client::new()
            .put(&peer.url)
            .header("if-match", condition)
            .json(&serde_json::json!({"mode":"disabled"}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            expected_status,
            "{condition}, {advances} competing writes"
        );
        let state = peer.state.lock().await;
        let writes: Vec<_> = state
            .calls
            .iter()
            .filter(|(method, _, _)| method.starts_with("PUT "))
            .collect();
        assert_eq!(writes.len(), attempts);
        assert!(
            writes
                .iter()
                .all(|(path, _, _)| path.ends_with("/snapshot"))
        );
        if writes.len() == 2 {
            assert_ne!(writes[0].1["if-match"], writes[1].1["if-match"]);
            assert_eq!(
                writes[0].1["x-boxlite-outbound-revision"],
                writes[1].1["x-boxlite-outbound-revision"]
            );
        }
        if expected_status == StatusCode::OK {
            assert_eq!(
                state.current.policy.mode,
                boxlite::runtime::options::NetworkMode::Disabled
            );
            assert_eq!(
                response.headers()["etag"],
                format!("\"{}\"", state.current.revision)
            );
        } else {
            assert_eq!(
                state.current.policy.mode,
                boxlite::runtime::options::NetworkMode::Enabled
            );
            assert!(!response.headers().contains_key("etag"));
        }
    }
}

#[tokio::test]
async fn outbound_serve_status_preserves_a_pending_revision_when_present() {
    let peer = outbound_peer(None).await;
    peer.state.lock().await.pending_revision = Some(OutboundRevision::parse("queued-b").unwrap());
    let response = reqwest::Client::new()
        .get(format!("{}/status", peer.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let status: serde_json::Value = response.json().await.unwrap();
    assert_eq!(status["application_state"], "pending");
    assert_eq!(status["observed"]["application_state"], "pending");
    assert_eq!(status["pending_revision"], "queued-b");
    assert_eq!(status["runtime_persisted"], status["persisted"]);
}

#[tokio::test]
async fn outbound_serve_public_update_does_not_retry_an_uncertain_ack() {
    let peer = outbound_peer(None).await;
    peer.state.lock().await.wrong_ack = true;
    let response = reqwest::Client::new()
        .put(&peer.url)
        .header("if-match", "\"rev-a\"")
        .json(&serde_json::json!({"mode":"disabled"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!response.headers().contains_key("etag"));
    let state = peer.state.lock().await;
    let writes: Vec<_> = state
        .calls
        .iter()
        .filter(|(path, _, _)| path.starts_with("PUT "))
        .collect();
    assert_eq!(writes.len(), 1, "uncertain application must not be retried");
    assert!(writes[0].0.ends_with("/snapshot"));
    assert_eq!(
        state.current.policy.mode,
        boxlite::runtime::options::NetworkMode::Disabled
    );
}
