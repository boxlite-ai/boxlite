//! End-to-end SSH control over `boxlite serve` and the Rust REST runtime.
//!
//! Two boundaries are covered. The transport tests drive the public
//! `LiteBox::ssh()` API against an in-process axum stub, pinning what crosses
//! the wire: method, path prefix, bearer, the complete configuration body, the
//! decoded status, and that a failed configure is sent exactly once. The
//! `ServeChild` tests then run the real server: observation never boots a box,
//! reconfiguration advances the generation, an invalid configuration leaves the
//! listener running, disable is idempotent, and the startup restrictions
//! (explicit main command, AutoResume) survive the round trip.

mod common;

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{OriginalUri, Path as AxumPath, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use boxlite::{
    BoxOptions, BoxStatus, BoxliteError, BoxliteRestOptions, BoxliteRuntime, RootfsSpec,
    SshAccount, SshCaConfig, SshConfig, SshStatus,
};
use common::serve::ServeChild;

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

/// Remove the box even when an assertion panics. Declared after `ServeChild`,
/// so it drops first and the server is still available to service the removal.
struct BoxCleanup {
    url: String,
    api_key: Option<&'static str>,
    box_ids: Vec<String>,
}

impl Drop for BoxCleanup {
    fn drop(&mut self) {
        for box_id in self.box_ids.drain(..) {
            let _ = Command::new(env!("CARGO_BIN_EXE_boxlite"))
                .args(["--url", &self.url, "rm", "--force", &box_id])
                .envs(self.api_key.map(|k| ("BOXLITE_API_KEY", k)))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn generate_key(path: &Path) {
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "ssh-rest-test", "-f"])
        .arg(path)
        .status()
        .expect("run ssh-keygen");
    assert!(status.success(), "ssh-keygen failed for {}", path.display());
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

// ============================================================================
// Transport boundary: the public Rust API against an axum stub.
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

/// An axum stub serving the box read and the SSH routes under the path prefix
/// `acme/team`, recording each SSH request before replying.
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

fn box_json(box_id: &str) -> serde_json::Value {
    serde_json::json!({
        "box_id": box_id,
        "name": null,
        "status": "running",
        "created_at": "2026-07-14T00:00:00Z",
        "updated_at": "2026-07-14T00:00:00Z",
        "pid": 42,
        "image": "alpine:latest",
        "cpus": 1,
        "memory_mib": 512,
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
    async fn start(replies: Vec<(u16, String)>) -> Self {
        let state = Arc::new(Mutex::new(StubState {
            requests: Vec::new(),
            replies: replies.into(),
        }));
        let app = axum::Router::new()
            .route(
                "/v1/acme/team/boxes/{id}",
                get(|AxumPath(id): AxumPath<String>| async move {
                    (StatusCode::OK, Json(box_json(&id)))
                }),
            )
            .route(
                "/v1/acme/team/boxes/{id}/ssh",
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

    fn requests(&self) -> Vec<RecordedRequest> {
        self.state.lock().expect("stub state").requests.clone()
    }
}

/// A REST runtime with a bearer key and the `acme/team` path prefix set.
fn prefixed_runtime(url: &str) -> BoxliteRuntime {
    BoxliteRuntime::rest(
        BoxliteRestOptions::new(url.to_string())
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
// Real `boxlite serve`: the full HTTP → handler → guest path.
// ============================================================================

fn local_key_config(keys: &Path) -> SshConfig {
    let host_key = keys.join("host");
    let user_key = keys.join("user");
    generate_key(&host_key);
    generate_key(&user_key);
    SshConfig {
        listen_address: "0.0.0.0:2222".into(),
        host_private_key: std::fs::read_to_string(&host_key).unwrap(),
        accounts: vec![SshAccount {
            login: "alice".into(),
            authorized_keys: vec![std::fs::read_to_string(user_key.with_extension("pub")).unwrap()],
            ca: None,
        }],
    }
}

/// The lifecycle the guide promises: observing never boots the box, every
/// configure restarts the listener (generation advances), an invalid
/// configuration leaves it running, disable is idempotent, and a stopped box
/// stays stopped through status and disable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_rest_journey() {
    let serve = ServeChild::start();
    let mut cleanup = BoxCleanup {
        url: serve.url(),
        api_key: None,
        box_ids: Vec::new(),
    };
    let keys = tempfile::tempdir().expect("key directory");
    let config = local_key_config(keys.path());

    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(serve.url())).expect("rest runtime");
    let sandbox = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("create box over REST");
    let box_id = sandbox.id().to_string();
    cleanup.box_ids.push(box_id.clone());

    // Creating the handle and observing SSH must not boot the box.
    assert_eq!(sandbox.ssh().status().await.unwrap(), disabled());
    let initial = sandbox.info().await.unwrap();
    assert_eq!(initial.status, BoxStatus::Configured);
    assert!(initial.pid.is_none());

    let first = sandbox
        .ssh()
        .configure(config.clone())
        .await
        .expect("configure");
    assert!(first.enabled);
    assert!(!first.listen_address.is_empty());
    assert!(!first.host_public_key.is_empty());
    assert!(!first.host_key_fingerprint.is_empty());

    // Every accepted configure restarts SSH; the host key is stable.
    let second = sandbox
        .ssh()
        .configure(config.clone())
        .await
        .expect("reconfigure");
    assert!(
        second.generation > first.generation,
        "repeated configure must advance the generation: {first:?} → {second:?}"
    );
    assert_eq!(second.host_key_fingerprint, first.host_key_fingerprint);

    // A semantically invalid configuration is rejected by the guest and
    // leaves the running listener untouched.
    let mut invalid = config;
    invalid.host_private_key = "not a private key".into();
    let error = sandbox
        .ssh()
        .configure(invalid)
        .await
        .expect_err("invalid configuration must be rejected");
    assert!(matches!(error, BoxliteError::InvalidArgument(_)), "{error}");
    let intact = sandbox
        .ssh()
        .status()
        .await
        .expect("status after rejection");
    assert!(intact.enabled);
    assert_eq!(intact.generation, second.generation);
    assert_eq!(intact.host_key_fingerprint, second.host_key_fingerprint);

    // Disable is idempotent.
    assert!(!sandbox.ssh().disable().await.unwrap().enabled);
    assert!(!sandbox.ssh().disable().await.unwrap().enabled);
    assert!(!sandbox.ssh().status().await.unwrap().enabled);

    // A stopped box is observable without being resumed.
    sandbox.stop().await.expect("stop box");
    let recovered = runtime
        .get(&box_id)
        .await
        .expect("get stopped box")
        .expect("stopped box still exists");
    assert_eq!(recovered.ssh().status().await.unwrap(), disabled());
    assert!(!recovered.ssh().disable().await.unwrap().enabled);
    let stopped = recovered.info().await.unwrap();
    assert_eq!(stopped.status, BoxStatus::Stopped);
    assert!(stopped.pid.is_none(), "observation must not restart the VM");

    let _ = runtime.remove(&box_id, true).await;
    serve.wait_until_no_boxes();
}

/// Authentication, missing boxes, and the sanitized body rejection, plus both
/// startup gates: an explicit main command and AutoResume disabled.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_rest_auth_errors_and_startup_gates() {
    let serve = ServeChild::start_with(&["--api-key", "expected-key"], Some("expected-key"));
    let mut cleanup = BoxCleanup {
        url: serve.url(),
        api_key: Some("expected-key"),
        box_ids: Vec::new(),
    };
    let keys = tempfile::tempdir().expect("key directory");
    let config = local_key_config(keys.path());

    let options = |cmd: Option<Vec<String>>, auto_resume: bool| BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        cmd,
        auto_resume: Some(auto_resume),
        auto_delete: Some(0),
        ..Default::default()
    };
    let runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(serve.url()).with_api_key("expected-key"))
            .expect("rest runtime");

    // The route is behind the key like every other box route.
    let http = reqwest::Client::new();
    let url = format!("{}/v1/boxes/x/ssh", serve.url());
    assert_eq!(http.get(&url).send().await.unwrap().status().as_u16(), 401);
    assert_eq!(
        http.get(&url)
            .bearer_auth("wrong-key")
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        401
    );

    // A malformed body is rejected with the fixed sanitized message before it
    // can reach anything that would echo it back.
    let box_for_body = runtime
        .create(options(None, true), None)
        .await
        .expect("create box");
    cleanup.box_ids.push(box_for_body.id().to_string());
    let body_url = format!("{}/v1/boxes/{}/ssh", serve.url(), box_for_body.id());
    let malformed = http
        .post(&body_url)
        .bearer_auth("expected-key")
        .header("content-type", "application/json")
        .body(r#"{"listen_address":"leak-me","host_private_key":"secret""#)
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status().as_u16(), 400);
    let body = malformed.text().await.unwrap();
    assert!(body.contains("invalid SSH configuration"), "{body}");
    assert!(
        !body.contains("leak-me") && !body.contains("secret"),
        "the rejection must not echo the body: {body}"
    );
    let wrong_type = http
        .post(&body_url)
        .bearer_auth("expected-key")
        .header("content-type", "text/plain")
        .body(r#"{"listen_address":"0.0.0.0:2222"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_type.status().as_u16(), 400);

    // A removed box reports not found through every SSH method. The handle is
    // taken before the removal, which is exactly how a stale client sees this.
    let stale_ssh = box_for_body.ssh();
    runtime
        .remove(box_for_body.id().as_ref(), true)
        .await
        .expect("remove box");
    let error = stale_ssh.status().await.unwrap_err();
    assert!(matches!(error, BoxliteError::NotFound(_)), "{error}");
    let error = stale_ssh.disable().await.unwrap_err();
    assert!(matches!(error, BoxliteError::NotFound(_)), "{error}");
    let error = stale_ssh.configure(full_config()).await.unwrap_err();
    assert!(matches!(error, BoxliteError::NotFound(_)), "{error}");

    // An explicit main command keeps the startup gate: configure refuses
    // instead of booting the box.
    let explicit = runtime
        .create(
            options(Some(vec!["sleep".into(), "300".into()]), true),
            None,
        )
        .await
        .expect("create explicit-cmd box");
    cleanup.box_ids.push(explicit.id().to_string());
    let error = explicit
        .ssh()
        .configure(config.clone())
        .await
        .expect_err("explicit main command must refuse implicit start");
    assert!(matches!(error, BoxliteError::InvalidState(_)), "{error}");
    let info = explicit.info().await.unwrap();
    assert_eq!(info.status, BoxStatus::Configured);
    assert!(
        info.pid.is_none(),
        "the refused configure must not boot the VM"
    );

    // A stopped box with AutoResume disabled is refused for configure, but
    // status and disable still observe it without resuming.
    let frozen = runtime
        .create(options(None, false), None)
        .await
        .expect("create auto_resume=false box");
    cleanup.box_ids.push(frozen.id().to_string());
    frozen.start().await.expect("start box");
    frozen.stop().await.expect("stop box");
    let error = frozen
        .ssh()
        .configure(config.clone())
        .await
        .expect_err("stopped box with AutoResume disabled must be refused");
    assert!(error.to_string().contains("AutoResume disabled"), "{error}");
    assert_eq!(frozen.ssh().status().await.unwrap(), disabled());
    assert!(!frozen.ssh().disable().await.unwrap().enabled);
    let info = frozen.info().await.unwrap();
    assert_eq!(info.status, BoxStatus::Stopped);
    assert!(info.pid.is_none(), "observation must not resume the box");

    for box_id in &cleanup.box_ids {
        let _ = runtime.remove(box_id, true).await;
    }
    serve.wait_until_no_boxes();
}
