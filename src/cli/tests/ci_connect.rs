#![cfg(unix)]
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{delete, post},
};
use serde_json::json;
use std::{
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Clone)]
struct Scenario {
    cancellation: &'static str,
    expired: bool,
    polled: Arc<Notify>,
    deletes: Arc<AtomicUsize>,
}

async fn start(State(s): State<Scenario>) -> Json<serde_json::Value> {
    Json(
        json!({"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "verification_uri":"https://github.com/login/device", "user_code":"TEST-CODE",
        "interval": if s.expired {60} else {1}, "expires_at": if s.expired {"2000-01-01T00:00:00Z"} else {"2099-01-01T00:00:00Z"}}),
    )
}
async fn poll(State(s): State<Scenario>) -> Json<serde_json::Value> {
    s.polled.notify_one();
    Json(json!({"status":"pending", "interval":1}))
}
async fn cancel(State(s): State<Scenario>) -> (StatusCode, Json<serde_json::Value>) {
    s.deletes.fetch_add(1, Ordering::SeqCst);
    (
        if s.cancellation == "error" {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::OK
        },
        Json(json!({"status":s.cancellation})),
    )
}
async fn exercise(cancellation: &'static str, expired: bool) -> String {
    let state = Scenario {
        cancellation,
        expired,
        polled: Arc::new(Notify::new()),
        deletes: Arc::new(AtomicUsize::new(0)),
    };
    let router = Router::new()
        .route("/v1/team/ci/connect", post(start))
        .route("/v1/team/ci/connect/{id}/poll", post(poll))
        .route("/v1/team/ci/connect/{id}", delete(cancel))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let home = tempfile::TempDir::new().unwrap();
    let mut child = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .args([
            "--home",
            home.path().to_str().unwrap(),
            "--url",
            &format!("http://{address}"),
            "--path-prefix",
            "team",
            "ci",
            "connect",
            "alice",
            "--no-browser",
        ])
        .env("BOXLITE_API_KEY", "fixture-key")
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_REST_PATH_PREFIX")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if !expired {
        tokio::time::timeout(Duration::from_secs(5), state.polled.notified())
            .await
            .unwrap();
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child.id() as i32),
            nix::sys::signal::Signal::SIGINT,
        )
        .unwrap();
    }
    let finished = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    if !finished {
        let _ = child.kill();
    }
    let output = child.wait_with_output().unwrap();
    server.abort();
    let _ = server.await;
    assert!(
        finished,
        "CLI ignored transaction expiry while waiting for the next poll"
    );
    assert_eq!(
        state.deletes.load(Ordering::SeqCst),
        1,
        "cancellation did not reach the API"
    );
    String::from_utf8(output.stderr).unwrap()
}

#[tokio::test]
async fn cancellation_reports_commit_winning_and_unconfirmed_delete() {
    assert!(exercise("cancelled", false).await.contains("cancelled"));
    assert!(
        exercise("connected", false)
            .await
            .contains("binding already completed")
    );
    assert!(
        exercise("error", false)
            .await
            .contains("cancellation could not be confirmed")
    );
}
#[tokio::test]
async fn transaction_expiry_interrupts_a_long_poll_interval() {
    assert!(exercise("cancelled", true).await.contains("timed out"));
}
