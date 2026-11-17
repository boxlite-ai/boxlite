//! Agent routes exercised through both REST transports and a loopback backend.

use std::sync::Arc;

use axum::{
    Json, Router,
    http::{StatusCode, header},
    routing::{get, post},
};
use boxlite::{
    BoxliteError, BoxliteRestOptions, BoxliteRuntime,
    agents::{AgentControlOptions, AgentResponse, AgentSteeringStatus},
};
use futures::StreamExt;
use serde_json::{Value, json};

use super::{STUB_BOX_ID, lifecycle_state, serve_router};

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_rest_routes_forward_a_conversation() {
    let upstream = Router::new()
        .route("/v1/boxes/{id}", get(|| async {
            Json(json!({"box_id":STUB_BOX_ID,"name":null,"status":"running",
                "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
                "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512}))
        }))
        .route("/v1/boxes/{id}/agents", post(|Json(body): Json<Value>| async move {
            assert_eq!(body["agent"], "opencode");
            (StatusCode::CREATED, Json(resource()))
        }))
        .route("/v1/boxes/{id}/agents/{agent}", get(|| async { Json(resource()) }))
        .route("/v1/boxes/{id}/agents/{agent}/close", post(|| async { StatusCode::NO_CONTENT }))
        .route("/v1/boxes/{id}/agents/{agent}/turns", post(|Json(body): Json<Value>| async move {
            assert_eq!(body["text"], "hello");
            if let Some(options) = body.get("options") {
                assert_eq!(options.get("data"), Some(&Value::Null));
            }
            (StatusCode::CREATED, Json(turn()))
        }))
        .route("/v1/boxes/{id}/agents/{agent}/turns/{turn}", get(|| async { Json(turn()) }))
        .route("/v1/boxes/{id}/agents/{agent}/requests/{request}/respond", post(|axum::extract::Path((_, _, request)): axum::extract::Path<(String, String, String)>, headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
            if request == "missing" {
                return (StatusCode::BAD_REQUEST, Json(json!({"error":{"message":"expected answer to request-1","type":"InvalidArgumentError","code":"invalid_argument"}})));
            }
            assert_eq!(headers.get("idempotency-key").unwrap(), "reply-key");
            assert_eq!(body, json!({"response":{"type":"permission","approved":false}}));
            (StatusCode::OK, Json(turn()))
        }))
        .route("/v1/boxes/{id}/agents/{agent}/turns/{turn}/steer", post(|headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers.get("idempotency-key").unwrap(), "steer-key");
            assert_eq!(body, json!({"text":"adjust"}));
            Json(json!({"id":"steer_test","turn_id":"msg_test","status":"accepted"}))
        }))
        .route("/v1/boxes/{id}/agents/{agent}/turns/{turn}/interrupt", post(|| async { StatusCode::NO_CONTENT }))
        .route("/v1/boxes/{id}/agents/{agent}/events", get(|| async {
            ([(header::CONTENT_TYPE, "text/event-stream")],
             "event: agent\ndata: {\"cursor\":null,\"agent_id\":\"ses_test\",\"turn_id\":\"msg_test\",\"kind\":\"message\",\"data\":{\"text\":\"hi\"}}\n\n")
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let (url, server) = serve_router(Arc::new(state)).await;
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(url)).unwrap();
    let sandbox = runtime.get(STUB_BOX_ID).await.unwrap().unwrap();

    let agent = sandbox
        .agents()
        .create("opencode", Default::default())
        .await
        .unwrap();
    let mut events = agent.events(Default::default()).await.unwrap();
    assert!(matches!(agent.state(), Err(BoxliteError::Unsupported(_))));
    assert!(matches!(
        agent.requests().await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert!(
        agent
            .capabilities()
            .unwrap()
            .operations
            .contains(&"agent.send".to_owned())
    );
    let turn = agent.send("hello", Default::default()).await.unwrap();
    agent
        .send(
            "hello",
            boxlite::agents::AgentSendOptions {
                data: Some(Value::Null),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(turn.state().unwrap().id, "msg_test");
    assert_eq!(
        agent
            .get_turn("msg_test")
            .await
            .unwrap()
            .state()
            .unwrap()
            .id,
        "msg_test"
    );
    let event = events.next().await.unwrap().unwrap();
    assert_eq!(event.data["text"], "hi");
    assert_eq!(event.turn_id.as_deref(), Some("msg_test"));
    let mut turn_events = turn.events(Default::default()).await.unwrap();
    assert_eq!(
        turn_events
            .next()
            .await
            .unwrap()
            .unwrap()
            .turn_id
            .as_deref(),
        Some("msg_test")
    );
    let receipt = turn
        .steer(
            "adjust",
            AgentControlOptions {
                idempotency_key: Some("steer-key".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(receipt.status, AgentSteeringStatus::Accepted);
    let answered = agent
        .respond(
            "request_test",
            AgentResponse::Permission { approved: false },
            AgentControlOptions {
                idempotency_key: Some("reply-key".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(answered.state().unwrap().id, "msg_test");
    let answer = || AgentResponse::Answer {
        text: "yes".into(),
        data: None,
    };
    let local_error = boxlite::Agent::for_test()
        .respond("missing", answer(), Default::default())
        .await
        .unwrap_err();
    let remote_error = agent
        .respond("missing", answer(), Default::default())
        .await
        .unwrap_err();
    assert!(matches!(local_error, BoxliteError::InvalidArgument(_)));
    assert!(matches!(remote_error, BoxliteError::InvalidArgument(_)));
    turn.interrupt(Default::default()).await.unwrap();
    agent.close(Default::default()).await.unwrap();

    server.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn agent_routes_enforce_authentication_and_reject_invalid_requests() {
    let mut state = lifecycle_state();
    state.api_key = Some("test-key".into());
    let (url, server) = serve_router(Arc::new(state)).await;
    let client = reqwest::Client::new();
    let path = format!("{url}/v1/boxes/example/agents");
    let denied = client
        .post(&path)
        .json(&json!({"agent":"opencode"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let invalid = client
        .post(&path)
        .bearer_auth("test-key")
        .json(&json!({"agent":"opencode", "options": null}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let error: Value = invalid.json().await.unwrap();
    assert_eq!(error["error"]["code"], "invalid_argument");
    server.abort();
}
