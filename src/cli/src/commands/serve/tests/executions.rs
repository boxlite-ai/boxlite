//! No-VM execution status and lifetime boundaries.

use super::super::handlers::executions::get_execution;
use super::*;

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
