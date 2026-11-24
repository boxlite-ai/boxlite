//! REST client contracts exercised against a loopback backend.

use super::STUB_BOX_ID;
use axum::{
    Json, Router,
    http::StatusCode,
    routing::{get, post},
};
use boxlite::{BoxliteRestOptions, BoxliteRuntime};
use serde_json::{Value, json};
use std::sync::Arc;

fn resource() -> Value {
    json!({"id":"ses_test", "agent":"opencode", "state":null,
        "config":{"tools":[],"mcp":[]},
        "capabilities":{"operations":["agent.send","agent.events"],"input_kinds":["text"],
            "max_queued_turns":null,"max_pending_steering":null,"idempotency_retention_seconds":null}})
}
fn turn() -> Value {
    json!({"id":"msg_test","agent_id":"ses_test","status":"queued", "cursor":null,
        "result":null,"requests":[],"steering":[]})
}
#[tokio::test]
async fn remote_wait_reports_terminal_turn_without_a_recorded_result() {
    let upstream = Router::new()
        .route(
            "/v1/boxes/{id}",
            get(|| async {
                Json(json!({"box_id":STUB_BOX_ID,"name":null,"status":"running",
                "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
                "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512}))
            }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}",
            get(|| async { Json(resource()) }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/turns/{turn}",
            get(|| async {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let mut state = turn();
                state["status"] = json!("completed");
                Json(state)
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let sandbox = runtime.get(STUB_BOX_ID).await.unwrap().unwrap();
    let agent = sandbox.agents().get("ses_test").await.unwrap();
    let turn = agent.get_turn("msg_test").await.unwrap();
    let error = turn
        .wait(boxlite::agents::AgentWaitOptions {
            timeout: Some(std::time::Duration::from_secs(5)),
        })
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("ended without a recorded outcome"),
        "{error}"
    );
    task.abort();
}
#[tokio::test]
async fn rest_review_config_accepts_additive_fields_and_validates_known_fields() {
    for invalid in [false, true] {
        let mut response = resource();
        response["config"]["provider_metadata"] = json!({"version": 2});
        response["config"]["model"] = if invalid {
            json!(123)
        } else {
            json!("provider/model")
        };
        assert!(boxlite::agents::records::parse_config(response["config"].clone()).is_err());
        let response = Arc::new(response);
        let upstream = Router::new()
            .route(
                "/v1/boxes/{id}",
                get(|| async {
                    Json(json!({"box_id":STUB_BOX_ID,"name":null,"status":"running",
                    "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
                    "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512}))
                }),
            )
            .route(
                "/v1/boxes/{id}/agents",
                post({
                    let response = Arc::clone(&response);
                    move || {
                        let response = Arc::clone(&response);
                        async move { (StatusCode::CREATED, Json((*response).clone())) }
                    }
                }),
            )
            .route(
                "/v1/boxes/{id}/agents/{agent}",
                get({
                    let response = Arc::clone(&response);
                    move || {
                        let response = Arc::clone(&response);
                        async move { Json((*response).clone()) }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let runtime =
            BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
        let sandbox = runtime.get(STUB_BOX_ID).await.unwrap().unwrap();
        for result in [
            sandbox.agents().get("ses_test").await,
            sandbox
                .agents()
                .create("opencode", Default::default())
                .await,
        ] {
            if invalid {
                assert!(result.is_err(), "malformed response config was accepted");
            } else {
                let agent = result.expect("additive response config fields must be accepted");
                assert_eq!(agent.id(), "ses_test");
                assert_eq!(
                    agent.config().unwrap().model.as_deref(),
                    Some("provider/model")
                );
            }
        }
        server.abort();
    }
}
