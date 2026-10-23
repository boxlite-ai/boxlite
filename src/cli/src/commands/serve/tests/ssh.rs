//! No-VM SSH boundary tests, run by `make test:unit:cli` and by the CI
//! coverage pass (`-p boxlite-cli --bins --test auth`).
//!
//! Three boundaries live here:
//!
//! 1. The public REST transport: `LiteBox::ssh()` against a recording axum
//!    stub, pinning what crosses the wire — method, path prefix, bearer, the
//!    complete configuration body, the decoded status, and that a failed
//!    configure is sent exactly once.
//! 2. The serve handlers: `build_router` and its middleware over a REST
//!    runtime pointed at the same kind of stub, through real sockets —
//!    missing boxes, auth, backend error mapping, the sanitized body
//!    rejection, the idle-stamp policy, and the AutoResume gate.
//! 3. The OpenAPI contract: every method's 409 and 503, driven through the
//!    real handlers, must be declared in `openapi/box.openapi.yaml` under
//!    the shared error refs.
//!
//! What genuinely needs a VM — the guest listener across configure
//! generations, invalid-configuration preservation, disable idempotence, the
//! startup gates against a real main command — stays in
//! `src/cli/tests/ssh_rest.rs`. Nothing here may claim to verify guest
//! behavior.

use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{OriginalUri, Path as AxumPath};
use axum::http::HeaderMap;

use boxlite::{SshAccount, SshCaConfig, SshConfig, SshStatus};

use super::*;

fn disabled() -> SshStatus {
    SshStatus {
        enabled: false,
        generation: 0,
        listen_address: String::new(),
        host_public_key: String::new(),
        host_key_fingerprint: String::new(),
    }
}

fn status_json(status: &SshStatus) -> String {
    serde_json::to_string(status).expect("serialize SshStatus")
}

/// A configuration that exercises every credential field: one keys-only
/// account and one with a certificate authority.
fn full_config() -> SshConfig {
    SshConfig {
        listen_address: "0.0.0.0:2222".into(),
        host_private_key: "private sentinel".into(),
        accounts: vec![
            SshAccount {
                login: "alice".into(),
                authorized_keys: vec!["alice authorized sentinel".into()],
                ca: None,
            },
            SshAccount {
                login: "bob".into(),
                authorized_keys: vec!["bob authorized sentinel".into()],
                ca: Some(SshCaConfig {
                    public_key: "ca sentinel".into(),
                    principal: "principal sentinel".into(),
                }),
            },
        ],
    }
}

fn expected_config_json() -> serde_json::Value {
    serde_json::json!({
        "listen_address": "0.0.0.0:2222",
        "host_private_key": "private sentinel",
        "accounts": [
            {
                "login": "alice",
                "authorized_keys": ["alice authorized sentinel"],
                "ca": null
            },
            {
                "login": "bob",
                "authorized_keys": ["bob authorized sentinel"],
                "ca": {"public_key": "ca sentinel", "principal": "principal sentinel"}
            }
        ]
    })
}

/// The body every handler-side POST sends: the complete wire shape, so a
/// rejection can only come from the boundary under test, never the payload.
/// Spelled as JSON rather than through the public config type, which is
/// deserialization-only.
fn config_body() -> String {
    expected_config_json().to_string()
}

/// The OpenAPI document `boxlite serve` answers to.
fn openapi_spec() -> serde_yaml::Value {
    serde_yaml::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../openapi/box.openapi.yaml"
        ))
        .expect("read openapi spec"),
    )
    .expect("parse openapi spec")
}

// ============================================================================
// Transport boundary: the public Rust API against a recording axum stub.
// ============================================================================

/// One SSH request the stub received, recorded before its scripted reply.
#[derive(Debug, Clone)]
struct RecordedRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

/// The stub's shared state: every SSH request so far, and the replies left to
/// hand out. A client retry would surface as an unexpected extra request or a
/// reply that is never consumed.
#[derive(Default)]
struct StubState {
    requests: Vec<RecordedRequest>,
    replies: std::collections::VecDeque<(u16, String)>,
}

/// An axum stub serving the box read and the SSH routes, recording each SSH
/// request before replying. [`SshStub::start`] serves them under the
/// `acme/team` prefix for the transport tests; [`SshStub::local`] serves the
/// unprefixed paths the serve handlers themselves call.
struct SshStub {
    url: String,
    state: Arc<Mutex<StubState>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for SshStub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn box_json(box_id: &str, status: &str, auto_resume: bool) -> serde_json::Value {
    serde_json::json!({
        "box_id": box_id,
        "name": null,
        "status": status,
        "created_at": "2026-07-14T00:00:00Z",
        "updated_at": "2026-07-14T00:00:00Z",
        "pid": 42,
        "image": "alpine:latest",
        "cpus": 1,
        "memory_mib": 512,
        "auto_resume": auto_resume,
    })
}

async fn ssh_route(
    State(state): State<Arc<Mutex<StubState>>>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let reply = {
        let mut state = state.lock().expect("stub state");
        state.requests.push(RecordedRequest {
            method: method.to_string(),
            path: uri.to_string(),
            authorization: headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
            body: String::from_utf8_lossy(&body).into_owned(),
        });
        state.replies.pop_front()
    };
    match reply {
        Some((status, body)) => (
            StatusCode::from_u16(status).expect("scripted status"),
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            body,
        )
            .into_response(),
        None => (StatusCode::INTERNAL_SERVER_ERROR, "no scripted reply left").into_response(),
    }
}

impl SshStub {
    async fn serve(
        prefix: &'static str,
        box_id: &'static str,
        status: &'static str,
        auto_resume: bool,
        replies: Vec<(u16, String)>,
    ) -> Self {
        let state = Arc::new(Mutex::new(StubState {
            requests: Vec::new(),
            replies: replies.into(),
        }));
        let app = axum::Router::new()
            .route(
                &format!("/v1{prefix}/boxes/{{id}}"),
                get(move |AxumPath(id): AxumPath<String>| async move {
                    // Only the named box exists; any other spelling reads as
                    // a missing box.
                    if id == box_id {
                        (StatusCode::OK, Json(box_json(&id, status, auto_resume))).into_response()
                    } else {
                        StatusCode::NOT_FOUND.into_response()
                    }
                }),
            )
            .route(
                &format!("/v1{prefix}/boxes/{{id}}/ssh"),
                axum::routing::post(ssh_route)
                    .get(ssh_route)
                    .delete(ssh_route),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            url: format!("http://127.0.0.1:{port}"),
            state,
            task,
        }
    }

    /// The transport tests' upstream: the `acme/team` prefix, one running box
    /// named `box-1`.
    async fn start(replies: Vec<(u16, String)>) -> Self {
        Self::serve("/acme/team", "box-1", "running", true, replies).await
    }

    /// The unprefixed upstream `serve` itself talks to, reporting the parent
    /// module's [`STUB_BOX_ID`]: any other spelling reads as a missing box.
    async fn local(status: &'static str, auto_resume: bool, replies: Vec<(u16, String)>) -> Self {
        Self::serve("", STUB_BOX_ID, status, auto_resume, replies).await
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.state.lock().expect("stub state").requests.clone()
    }
}

/// A REST runtime with a bearer key and the `acme/team` path prefix set.
fn prefixed_runtime(url: &str) -> BoxliteRuntime {
    BoxliteRuntime::rest(
        boxlite::BoxliteRestOptions::new(url.to_string())
            .with_api_key("ssh-stub-key")
            .with_path_prefix("acme/team"),
    )
    .expect("rest runtime")
}

/// The owned handle crosses the wire intact: one request per operation, each
/// under the prefix and bearer, carrying the complete configuration and
/// decoding the production status type.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_rest_public_api_round_trips_over_the_wire() {
    let active = SshStatus {
        enabled: true,
        generation: 7,
        listen_address: "0.0.0.0:2222".into(),
        host_public_key: "public host".into(),
        host_key_fingerprint: "SHA256:test".into(),
    };
    let stub = SshStub::start(vec![
        (200, status_json(&active)),
        (200, status_json(&active)),
        (200, status_json(&disabled())),
    ])
    .await;

    let sandbox = prefixed_runtime(&stub.url)
        .get("box-1")
        .await
        .expect("get box")
        .expect("box exists");
    let ssh = sandbox.ssh();
    drop(sandbox);

    assert_eq!(ssh.configure(full_config()).await.unwrap(), active);
    assert_eq!(ssh.status().await.unwrap(), active);
    assert_eq!(ssh.disable().await.unwrap(), disabled());

    let requests = stub.requests();
    assert_eq!(requests.len(), 3, "exactly one request per operation");
    for (request, method) in requests.iter().zip(["POST", "GET", "DELETE"]) {
        assert_eq!(request.method, method, "{request:?}");
        assert_eq!(request.path, "/v1/acme/team/boxes/box-1/ssh");
        assert_eq!(
            request.authorization.as_deref(),
            Some("Bearer ssh-stub-key"),
            "{request:?}"
        );
    }
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&requests[0].body).unwrap(),
        expected_config_json(),
        "configure must send the OpenAPI SshConfig shape"
    );
    assert!(requests[1].body.is_empty(), "GET must send no body");
    assert!(requests[2].body.is_empty(), "DELETE must send no body");
}

/// A failed configure is sent exactly once: the guest restarts SSH on every
/// accepted call, so a client retry would disconnect clients a second time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_rest_configure_failure_is_sent_exactly_once() {
    let stub = SshStub::start(vec![(
        500,
        serde_json::json!({
            "error": {"message": "injected configure failure", "type": "Error", "code": "internal"}
        })
        .to_string(),
    )])
    .await;

    let sandbox = prefixed_runtime(&stub.url)
        .get("box-1")
        .await
        .expect("get box")
        .expect("box exists");
    let error = sandbox.ssh().configure(full_config()).await.unwrap_err();
    assert!(
        error.to_string().contains("injected configure failure"),
        "{error}"
    );
    assert_eq!(
        stub.requests().len(),
        1,
        "a failed configure must not be retried"
    );
}

/// A response missing required status fields is an error, never a fabricated
/// disabled status.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_rest_status_missing_fields_fail_closed() {
    let stub = SshStub::start(vec![(200, r#"{"enabled":false}"#.to_string())]).await;
    let sandbox = prefixed_runtime(&stub.url)
        .get("box-1")
        .await
        .expect("get box")
        .expect("box exists");

    let error = sandbox.ssh().status().await.unwrap_err();
    assert!(
        error.to_string().contains("failed to parse response"),
        "{error}"
    );
}

// ============================================================================
// Handler boundary: the real router and middleware, still no VM.
// ============================================================================

/// An upstream error envelope in the wire shape every boxlite server answers
/// with, so the client's own code-to-variant table does the mapping.
fn error_envelope(code: &str) -> String {
    serde_json::json!({
        "error": {"message": format!("injected {code} failure"), "type": "Error", "code": code}
    })
    .to_string()
}

/// `boxlite serve`'s own wiring minus the process: the real router and its
/// middleware over a REST runtime pointing at `upstream`.
async fn serve_over(
    upstream: &SshStub,
    api_key: Option<&str>,
) -> (String, Arc<AppState>, tokio::task::JoinHandle<()>) {
    let state = Arc::new(AppState {
        runtime: BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(upstream.url.clone()))
            .expect("rest runtime"),
        boxes: RwLock::new(HashMap::new()),
        executions: RwLock::new(HashMap::new()),
        api_key: api_key.map(str::to_string),
        lifecycle: RwLock::new(HashMap::new()),
        last_activity: RwLock::new(HashMap::new()),
    });
    let (base, server) = serve_router(Arc::clone(&state)).await;
    (base, state, server)
}

/// One SSH request through the real socket, optionally bearer-authenticated
/// and optionally carrying an `(content-type, body)` pair.
async fn ssh_call(
    method: &str,
    url: &str,
    key: Option<&str>,
    body: Option<(&str, &str)>,
) -> reqwest::Response {
    let mut request = reqwest::Client::new().request(method.parse().expect("method"), url);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    if let Some((content_type, body)) = body {
        request = request
            .header("content-type", content_type)
            .body(body.to_string());
    }
    request.send().await.expect("request must reach the server")
}

/// A removed box reports not found through every SSH method, and nothing
/// reaches the backend for an unknown box.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_routes_report_a_missing_box_as_404_for_every_method() {
    let upstream = SshStub::local("running", true, Vec::new()).await;
    let (base, _state, server) = serve_over(&upstream, None).await;

    for method in ["POST", "GET", "DELETE"] {
        let response = ssh_call(
            method,
            &format!("{base}/v1/boxes/no-such-box/ssh"),
            None,
            Some(("application/json", &config_body())),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method}");
        let body: serde_json::Value = response.json().await.expect("error body");
        assert_eq!(body["error"]["code"], "not_found", "{method}");
    }

    assert!(
        upstream.requests().is_empty(),
        "no SSH request may reach the backend for an unknown box"
    );
    server.abort();
    upstream.task.abort();
}

/// The route is behind the key like every other box route: no key or the
/// wrong key is refused for all three methods before anything runs, and the
/// right key still passes the gate.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_routes_refuse_requests_without_the_api_key() {
    let upstream = SshStub::local("running", true, vec![(200, status_json(&disabled()))]).await;
    let (base, _state, server) = serve_over(&upstream, Some("serve-key")).await;
    let url = format!("{base}/v1/boxes/{STUB_BOX_ID}/ssh");

    for method in ["POST", "GET", "DELETE"] {
        for key in [None, Some("wrong-key")] {
            let response = ssh_call(
                method,
                &url,
                key,
                Some(("application/json", &config_body())),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {key:?}"
            );
        }
    }
    assert!(
        upstream.requests().is_empty(),
        "a refused request must not reach the backend"
    );

    let response = ssh_call("GET", &url, Some("serve-key"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    server.abort();
    upstream.task.abort();
}

/// Backend failures keep their class through both mappings (HTTP →
/// `BoxliteError` in the client, `BoxliteError` → HTTP in the handler), for
/// every method: 409 `invalid_state` and 503 `upstream_unavailable` must
/// arrive as themselves and be declared in OpenAPI under the shared error refs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_routes_map_backend_errors_to_the_wire_contract() {
    let spec = openapi_spec();
    let cases = [
        (
            "invalid_state",
            StatusCode::CONFLICT,
            "InvalidStateError",
            "invalid_state",
            "#/components/responses/ConflictError",
        ),
        (
            "upstream_unavailable",
            StatusCode::SERVICE_UNAVAILABLE,
            "UpstreamUnavailableError",
            "upstream_unavailable",
            "#/components/responses/ServiceUnavailableError",
        ),
    ];
    for (code, status, error_type, error_code, error_ref) in cases {
        for method in ["POST", "GET", "DELETE"] {
            let upstream = SshStub::local(
                "running",
                true,
                vec![(status.as_u16(), error_envelope(code))],
            )
            .await;
            let (base, _state, server) = serve_over(&upstream, None).await;
            let response = ssh_call(
                method,
                &format!("{base}/v1/boxes/{STUB_BOX_ID}/ssh"),
                None,
                Some(("application/json", &config_body())),
            )
            .await;
            assert_eq!(response.status(), status, "{method} {code}");
            let declared = spec["paths"]["/{prefix}/boxes/{box_id}/ssh"]
                [method.to_ascii_lowercase()]["responses"][response.status().as_str()]["$ref"]
                .as_str();
            assert_eq!(
                declared,
                Some(error_ref),
                "{method} {status} OpenAPI response"
            );
            let body: serde_json::Value = response.json().await.expect("error body");
            assert_eq!(body["error"]["type"], error_type, "{method} {code}");
            assert_eq!(body["error"]["code"], error_code, "{method} {code}");
            assert!(
                body["error"]["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("injected")),
                "the upstream's sentence must survive: {body}"
            );
            assert_eq!(upstream.requests().len(), 1, "{method} {code}");
            server.abort();
            upstream.task.abort();
        }
    }
}

/// The configure boundary answers malformed JSON, a wrong field type, a wrong
/// content type, and a body missing required fields with the fixed sanitized
/// message — serde's own would quote the body, and the body carries a private
/// key. Extraction rejects before box resolution, so even a missing box
/// cannot outrank it and nothing reaches the backend.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_configure_rejects_bad_bodies_with_a_sanitized_400() {
    let upstream = SshStub::local("running", true, Vec::new()).await;
    let (base, _state, server) = serve_over(&upstream, None).await;
    // Truncated JSON, missing required fields, a non-string field, and a
    // complete body under the wrong content type — the only case whose JSON
    // would parse.
    let valid = r#"{"listen_address":"0","host_private_key":"","accounts":[]}"#;
    let cases = [
        ("application/json", r#"{"listen_address":"leak-me""#),
        ("application/json", r#"{"host_private_key":"secret"}"#),
        (
            "application/json",
            r#"{"listen_address":1234,"host_private_key":"","accounts":[]}"#,
        ),
        ("text/plain", valid),
    ];

    for (content_type, body) in cases {
        let response = ssh_call(
            "POST",
            &format!("{base}/v1/boxes/does-not-exist/ssh"),
            None,
            Some((content_type, body)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{content_type}");
        let body = response.text().await.expect("error body");
        assert!(body.contains("invalid SSH configuration"), "{body}");
        assert!(
            !body.contains("leak-me") && !body.contains("secret") && !body.contains("1234"),
            "the rejection must not echo the body: {body}"
        );
    }

    assert!(
        upstream.requests().is_empty(),
        "a rejected body must be answered before any backend operation"
    );
    server.abort();
    upstream.task.abort();
}

/// Send one body to the real configure route and describe what is wrong if the
/// answer is not the sanitized rejection: every case is checked, so a failure
/// names all three levels at once instead of stopping at the first.
async fn rejection_failure(level: &str, url: &str, body: &serde_json::Value) -> Option<String> {
    let response = ssh_call(
        "POST",
        url,
        None,
        Some(("application/json", &body.to_string())),
    )
    .await;
    let status = response.status();
    let text = response.text().await.expect("error body");
    let envelope: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    let mut why: Vec<String> = [
        (status != StatusCode::BAD_REQUEST).then(|| format!("status {status}")),
        (envelope["error"]["code"] != "invalid_argument")
            .then(|| format!("code {}", envelope["error"]["code"])),
        (envelope["error"]["message"] != "invalid SSH configuration")
            .then(|| format!("message {}", envelope["error"]["message"])),
        text.contains("leak-me")
            .then(|| "the body was echoed".to_string()),
    ]
    .into_iter()
    .flatten()
    .collect();
    why.sort();
    (!why.is_empty()).then(|| format!("{level}: {}", why.join(", ")))
}

/// A misspelled field is refused, never dropped: these bodies carry credentials,
/// so silently ignoring `authorized_key` would leave an account the operator
/// believes is keyed. All three levels reject with the same sanitized 400 before
/// the box is resolved, so nothing reaches the backend.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_configure_rejects_unknown_fields_at_every_level() {
    let upstream = SshStub::local("running", true, Vec::new()).await;
    let (base, _state, server) = serve_over(&upstream, None).await;

    let cases = [
        (
            "top-level",
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "leak-me",
                "accounts": [{"login": "alice", "authorized_keys": ["leak-me"]}],
                "listen_port": "leak-me",
            }),
        ),
        (
            "account: `authorized_key` typo beside a valid CA",
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "leak-me",
                "accounts": [{
                    "login": "alice",
                    "authorized_key": ["leak-me"],
                    "ca": {"public_key": "leak-me", "principal": "leak-me"},
                }],
            }),
        ),
        (
            "ca",
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "leak-me",
                "accounts": [{
                    "login": "alice",
                    "ca": {
                        "public_key": "leak-me",
                        "principal": "leak-me",
                        "certificate": "leak-me",
                    },
                }],
            }),
        ),
    ];

    let url = format!("{base}/v1/boxes/{STUB_BOX_ID}/ssh");
    let mut failures = Vec::new();
    for (level, body) in cases {
        if let Some(failure) = rejection_failure(level, &url, &body).await {
            failures.push(failure);
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");

    assert!(
        upstream.requests().is_empty(),
        "a rejected body must be answered before any box work"
    );

    let spec = openapi_spec();
    for name in ["SshConfig", "SshAccount", "SshCaConfig"] {
        assert_eq!(
            spec["components"]["schemas"][name]["additionalProperties"].as_bool(),
            Some(false),
            "{name} must refuse unknown fields in the spec too"
        );
    }
    server.abort();
    upstream.task.abort();
}

/// The shortcuts a hand-written body may take reach the guest in one complete
/// form: omitted `authorized_keys` defaults to `[]`, and an omitted or explicit
/// `ca: null` stays `null`, so no request needs the backend to guess.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_configure_transmits_defaulted_and_explicit_optional_fields() {
    let ca = serde_json::json!({"public_key": "ca sentinel", "principal": "principal sentinel"});
    let keys = serde_json::json!(["alice authorized sentinel"]);
    let cases = [
        (expected_config_json(), expected_config_json()),
        (
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "private sentinel",
                "accounts": [{"login": "bob", "ca": ca.clone()}],
            }),
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "private sentinel",
                "accounts": [{"login": "bob", "authorized_keys": [], "ca": ca.clone()}],
            }),
        ),
        (
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "private sentinel",
                "accounts": [{"login": "alice", "authorized_keys": keys.clone()}],
            }),
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "private sentinel",
                "accounts": [{"login": "alice", "authorized_keys": keys.clone(), "ca": null}],
            }),
        ),
        (
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "private sentinel",
                "accounts": [{"login": "alice", "authorized_keys": keys.clone(), "ca": null}],
            }),
            serde_json::json!({
                "listen_address": "0.0.0.0:2222",
                "host_private_key": "private sentinel",
                "accounts": [{"login": "alice", "authorized_keys": keys.clone(), "ca": null}],
            }),
        ),
    ];

    for (sent, forwarded) in cases {
        let upstream = SshStub::local("running", true, vec![(200, status_json(&disabled()))]).await;
        let (base, _state, server) = serve_over(&upstream, None).await;
        let response = ssh_call(
            "POST",
            &format!("{base}/v1/boxes/{STUB_BOX_ID}/ssh"),
            None,
            Some(("application/json", &sent.to_string())),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{sent}");
        let requests = upstream.requests();
        assert_eq!(requests.len(), 1, "{sent}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&requests[0].body).unwrap(),
            forwarded,
            "{sent}"
        );
        server.abort();
        upstream.task.abort();
    }
}

/// Wraps a type so `Serialize` can be detected at runtime. The bound is
/// resolved at the call site; putting it on the test itself would turn the
/// regression into a compile error instead of a failing assertion.
struct IsSerialize<T>(std::marker::PhantomData<T>);

trait SerializesViaSerde {
    fn serializes(&self) -> bool;
}

impl<T: serde::Serialize> SerializesViaSerde for &IsSerialize<T> {
    fn serializes(&self) -> bool {
        true
    }
}

/// Autoref fallback, chosen only when the impl above does not apply.
impl<T> IsSerialize<T> {
    fn serializes(&self) -> bool {
        false
    }
}

macro_rules! serializes {
    ($type:ty) => {{
        let wrapped = IsSerialize::<$type>(std::marker::PhantomData);
        (&&wrapped).serializes()
    }};
}

/// Configuration travels one way only: the REST client's private borrowed
/// request type serializes a configuration, so no caller can round-trip a
/// private key through the public types. `SshStatus` is a response body and
/// implements both directions.
#[test]
fn ssh_configuration_types_deserialize_but_do_not_serialize() {
    assert!(serializes!(SshStatus), "SshStatus is a response body");
    let serializing: Vec<&str> = [
        ("SshConfig", serializes!(SshConfig)),
        ("SshAccount", serializes!(SshAccount)),
        ("SshCaConfig", serializes!(SshCaConfig)),
    ]
    .into_iter()
    .filter_map(|(name, serializes)| serializes.then_some(name))
    .collect();
    assert!(
        serializing.is_empty(),
        "configuration types must not serialize: {serializing:?}"
    );
}

/// The happy path through the real handlers: every method answers with the
/// backend's status JSON decoded, the configure body crosses intact, and
/// only configure — which may boot the box — resets the idle clock; `GET`,
/// `HEAD` and `DELETE` leave it untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_round_trips_decode_status_and_only_configure_stamps_activity() {
    let active = SshStatus {
        enabled: true,
        generation: 9,
        listen_address: "0.0.0.0:2222".into(),
        host_public_key: "public host".into(),
        host_key_fingerprint: "SHA256:test".into(),
    };
    let upstream = SshStub::local(
        "running",
        true,
        vec![
            (200, status_json(&active)),
            (200, status_json(&active)),
            (200, status_json(&disabled())),
            (200, status_json(&active)),
        ],
    )
    .await;
    let (base, state, server) = serve_over(&upstream, None).await;
    let url = format!("{base}/v1/boxes/{STUB_BOX_ID}/ssh");

    let seeded = Instant::now();
    state
        .last_activity
        .write()
        .await
        .insert(STUB_BOX_ID.to_string(), seeded);

    for (method, want) in [("GET", &active), ("HEAD", &active), ("DELETE", &disabled())] {
        let response = ssh_call(method, &url, None, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{method}");
        // A HEAD response carries no body to decode; its backend read still
        // happens, which the recorded requests below prove.
        if method != "HEAD" {
            let body: SshStatus = response.json().await.expect("status body");
            assert_eq!(body, *want, "{method}");
        }
        assert_eq!(
            state.last_activity.read().await.get(STUB_BOX_ID),
            Some(&seeded),
            "{method} must not reset the idle clock"
        );
    }

    let response = ssh_call(
        "POST",
        &url,
        None,
        Some(("application/json", &config_body())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: SshStatus = response.json().await.expect("status body");
    assert_eq!(body, active);
    assert!(
        state
            .last_activity
            .read()
            .await
            .get(STUB_BOX_ID)
            .is_some_and(|stamp| *stamp > seeded),
        "configure is use of the box and must reset the idle clock"
    );

    let requests = upstream.requests();
    let methods: Vec<&str> = requests.iter().map(|r| r.method.as_str()).collect();
    assert_eq!(methods, ["GET", "GET", "DELETE", "POST"]);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&requests[3].body).unwrap(),
        expected_config_json(),
        "configure must forward the OpenAPI SshConfig shape"
    );
    assert!(requests[0].body.is_empty() && requests[2].body.is_empty());
    server.abort();
    upstream.task.abort();
}

/// A stopped box with AutoResume disabled keeps the gate: the metadata read
/// still happens, but configure is refused before the guest is asked to
/// reconfigure anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_configure_refuses_before_any_ssh_operation_when_auto_resume_is_off() {
    let upstream = SshStub::local("stopped", false, Vec::new()).await;
    let (base, _state, server) = serve_over(&upstream, None).await;

    let response = ssh_call(
        "POST",
        &format!("{base}/v1/boxes/{STUB_BOX_ID}/ssh"),
        None,
        Some(("application/json", &config_body())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: serde_json::Value = response.json().await.expect("error body");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("AutoResume disabled")),
        "{body}"
    );

    assert!(
        upstream.requests().is_empty(),
        "the refusal must come before any SSH operation"
    );
    server.abort();
    upstream.task.abort();
}
