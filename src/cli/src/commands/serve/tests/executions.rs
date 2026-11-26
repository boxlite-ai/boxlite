//! No-VM execution status and lifetime boundaries.

use super::super::handlers::executions::{finish_sync_execution, get_execution, start_execution};
use super::*;

async fn sync_response_json(response: axum::response::Response) -> serde_json::Value {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn sync_exec_returns_output_and_truncates_each_stream_independently() {
    for truncated in [false, true] {
        let (execution, stdout, stderr, mut stdin, result) = Execution::stub("sync");
        let out = "a".repeat(if truncated { 1025 } else { 1024 });
        stdout.send(out).unwrap();
        stderr.send("err".into()).unwrap();
        result
            .send(boxlite::ExecResult {
                exit_code: 7,
                error_message: None,
            })
            .unwrap();
        drop((stdout, stderr, result));
        let response = finish_sync_execution(execution, Duration::from_secs(1), 1024).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(stdin.recv().await.is_none());
        assert_eq!(
            sync_response_json(response).await,
            serde_json::json!({
                "exit_code": 7,
                "stdout": "a".repeat(1024),
                "stderr": "err",
                "stdout_truncated": truncated,
                "stderr_truncated": false,
            })
        );
    }
}

#[tokio::test]
async fn sync_exec_times_out_and_kills_the_execution() {
    let (killed_tx, mut killed_rx) = tokio::sync::mpsc::unbounded_channel();
    let (execution, stdout, stderr, _stdin, result) =
        Execution::stub_with_kill_hook("sync", move || {
            killed_tx.send(()).unwrap();
        });
    let response = finish_sync_execution(execution, Duration::from_millis(100), 1024).await;
    drop((stdout, stderr, result));
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
    killed_rx
        .try_recv()
        .expect("timeout did not kill the execution");
    let body = sync_response_json(response).await;
    assert_eq!(body["error"]["type"], "TimeoutError");
    assert_eq!(body["error"]["code"], "timeout");
    assert_eq!(body["error"]["message"], "execution timed out");
}

#[tokio::test]
async fn sync_exec_route_rejects_invalid_arguments() {
    let (url, server) = serve_router(Arc::new(lifecycle_state())).await;
    let client = reqwest::Client::new();
    for request in [
        r#"{"command":"","sync":true}"#,
        r#"{"command":"true","sync":true,"timeout_seconds":0.09}"#,
        r#"{"command":"true","sync":true,"timeout_seconds":301}"#,
        r#"{"command":"true","sync":true,"max_output_bytes":1023}"#,
        r#"{"command":"true","sync":true,"max_output_bytes":10485761}"#,
        r#"{"command":"true","sync":true,"tty":true}"#,
        r#"{"command":"true","sync":true,"stdin":""}"#,
    ] {
        let response = client
            .post(format!("{url}/v1/boxes/does-not-exist/exec"))
            .header("content-type", "application/json")
            .body(request)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{request}");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "InvalidArgumentError");
        assert_eq!(body["error"]["code"], "invalid_argument");
    }
    server.abort();
}

#[tokio::test]
async fn async_exec_route_returns_created_when_sync_is_false_or_omitted() {
    let upstream_app = axum::Router::new()
        .route(
            "/v1/boxes/{id}",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({
                    "box_id": STUB_BOX_ID,
                    "name": STUB_BOX_NAME,
                    "status": "running",
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "pid": null,
                    "image": "alpine:latest",
                    "cpus": 1,
                    "memory_mib": 512,
                    "auto_stop": 0,
                    "auto_delete": 0,
                    "auto_resume": true,
                }))
            }),
        )
        .route(
            "/v1/boxes/{id}/exec",
            axum::routing::post(|| async {
                (
                    StatusCode::CREATED,
                    axum::Json(serde_json::json!({"execution_id": "exec-async-1"})),
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", listener.local_addr().unwrap());
    let upstream_task = tokio::spawn(async move {
        let _ = axum::serve(listener, upstream_app).await;
    });

    let mut state = lifecycle_state();
    state.runtime = BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(upstream_url)).unwrap();
    let (url, server) = serve_router(Arc::new(state)).await;
    let client = reqwest::Client::new();

    for request in [
        r#"{"command":"true"}"#,
        r#"{"command":"true","sync":false}"#,
    ] {
        let response = client
            .post(format!("{url}/v1/boxes/{STUB_BOX_ID}/exec"))
            .header("content-type", "application/json")
            .body(request)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED, "{request}");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["execution_id"], "exec-async-1");
    }

    server.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn sync_exec_prevents_auto_stop_and_cancellation_restarts_the_idle_window() {
    let started = Arc::new(tokio::sync::Notify::new());
    let upstream = stub_upstream_with_pending_exec("running", true, Some(started.clone())).await;
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(upstream.url.clone())).unwrap();
    let state = Arc::new(state);
    state
        .set_lifecycle(
            STUB_BOX_ID,
            LifecyclePolicy {
                auto_stop: 60,
                auto_delete: 0,
            },
        )
        .await;
    let now = Instant::now();
    state
        .last_activity
        .write()
        .await
        .insert(STUB_BOX_ID.to_owned(), now - Duration::from_secs(600));

    {
        let request =
            serde_json::from_value(serde_json::json!({"command": "true", "sync": true})).unwrap();
        let handler = start_execution(
            axum::extract::State(state.clone()),
            axum::extract::Path(STUB_BOX_NAME.to_owned()),
            Json(request),
        );
        tokio::pin!(handler);
        tokio::select! {
            _ = started.notified() => {},
            response = &mut handler => panic!("sync exec returned early: {}", response.status()),
            _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("exec did not reach upstream"),
        }
        run_lifecycle_once(&state, now).await;
        assert_eq!(
            upstream.stops(),
            0,
            "in-flight sync exec must prevent AutoStop"
        );
    } // Cancel the handler before the upstream responds.

    let finished = Instant::now();
    run_lifecycle_once(&state, finished).await;
    assert_eq!(
        upstream.stops(),
        0,
        "cancellation must refresh the idle clock"
    );
    run_lifecycle_once(&state, finished + Duration::from_secs(61)).await;
    assert_eq!(
        upstream.stops(),
        1,
        "the cancelled exec must no longer pin the box"
    );
    upstream.task.abort();
}

async fn recorded_exit(state: &AppState, box_id: &str, exec_id: &str, code: i32) {
    let (execution, _out, _err, _input, result) = Execution::stub(exec_id);
    state.watch_recovered(box_id, exec_id, execution).await;
    result
        .send(boxlite::ExecResult {
            exit_code: code,
            error_message: None,
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.recovered_terminal(box_id, exec_id).await.is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("watcher did not record exit");
}

#[tokio::test]
async fn recovered_status_uses_the_canonical_box_after_exit() {
    let upstream = stub_upstream("stopped", true).await;
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(upstream.url.clone())).unwrap();
    let state = Arc::new(state);
    recorded_exit(&state, STUB_BOX_ID, "exec-1", 42).await;
    let response = get_execution(
        axum::extract::State(state),
        axum::extract::Path((STUB_BOX_NAME.to_string(), "exec-1".to_string())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["status"], "completed");
    assert_eq!(body["exit_code"], 42);
}

#[tokio::test]
async fn repeated_pending_recovery_drops_the_duplicate_waiter() {
    let state = lifecycle_state();
    let (first, _out1, _err1, _input1, result1) = Execution::stub("exec-1");
    state.watch_recovered("box-1", "exec-1", first).await;
    let (second, _out2, _err2, _input2, result2) = Execution::stub("exec-1");
    state.watch_recovered("box-1", "exec-1", second).await;
    let duplicate_released = tokio::time::timeout(Duration::from_secs(1), result2.closed()).await;
    result1
        .send(boxlite::ExecResult {
            exit_code: 3,
            error_message: None,
        })
        .unwrap();
    assert!(
        duplicate_released.is_ok(),
        "a second pending watcher retained its execution"
    );
}

#[tokio::test]
async fn recovered_wait_failure_is_not_an_execution_exit() {
    let upstream = stub_upstream("stopped", true).await;
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(upstream.url.clone())).unwrap();
    let state = Arc::new(state);
    let (execution, _out, _err, _input, result) = Execution::stub("exec-1");
    state
        .watch_recovered(STUB_BOX_ID, "exec-1", execution)
        .await;
    drop(result);
    tokio::time::timeout(Duration::from_secs(5), async {
        while state
            .recovered_terminal(STUB_BOX_ID, "exec-1")
            .await
            .is_none()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let response = get_execution(
        axum::extract::State(state),
        axum::extract::Path((STUB_BOX_ID.to_string(), "exec-1".to_string())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn inventory_polling_does_not_refresh_the_idle_clock() {
    let state = Arc::new(lifecycle_state());
    let (url, server) = serve_router(Arc::clone(&state)).await;
    let client = reqwest::Client::new();
    for method in [reqwest::Method::GET, reqwest::Method::HEAD] {
        let _ = client
            .request(method, format!("{url}/v1/boxes/box-1/executions"))
            .send()
            .await
            .unwrap();
        assert!(state.last_activity.read().await.is_empty());
    }
    let _ = client
        .get(format!("{url}/v1/boxes/box-1/executions/exec-1"))
        .send()
        .await
        .unwrap();
    assert!(state.last_activity.read().await.contains_key("box-1"));
    server.abort();
}

#[tokio::test]
async fn implicit_resume_forgets_the_previous_main_status() {
    let upstream = stub_upstream("stopped", true).await;
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(upstream.url.clone())).unwrap();
    recorded_exit(&state, STUB_BOX_ID, "main-session", 42).await;
    let _box = get_or_resume_box(&state, STUB_BOX_NAME)
        .await
        .expect("resume is allowed");
    assert!(
        state
            .recovered_terminal(STUB_BOX_ID, "main-session")
            .await
            .is_none(),
        "the next main process must not inherit the previous run's exit"
    );
}

#[tokio::test]
async fn recovered_terminal_uses_the_existing_retention_grace() {
    let state = lifecycle_state();
    recorded_exit(&state, "box-1", "exec-1", 42).await;
    run_reap_once(
        &state,
        Instant::now() + COMPLETED_RETENTION_GRACE + Duration::from_secs(1),
        DEFAULT_RECONNECT_GRACE,
        DEFAULT_SHUTDOWN_GRACE,
        DEFAULT_MAX_SESSION_LIFETIME,
    )
    .await;
    assert!(
        state.recovered_terminal("box-1", "exec-1").await.is_none(),
        "recovered status outlived the server's execution retention grace"
    );
}
