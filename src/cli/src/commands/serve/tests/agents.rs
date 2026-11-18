//! Agent routes exercised through both REST transports and a loopback backend.

use std::sync::Arc;

use axum::{
    Json, Router,
    http::{StatusCode, header},
    response::IntoResponse,
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

#[tokio::test]
async fn agent_routes_refuse_to_resume_a_stopped_box_when_disabled() {
    let upstream = Router::new().route(
        "/v1/boxes/{id}",
        get(|| async {
            Json(json!({"box_id":STUB_BOX_ID,"name":null,"status":"stopped",
            "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
            "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512,"auto_resume":false}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let (url, server) = serve_router(Arc::new(state)).await;
    let client = reqwest::Client::new();
    let path = format!("{url}/v1/boxes/{STUB_BOX_ID}/agents");
    let create = client
        .post(&path)
        .json(&json!({"agent":"opencode"}))
        .send()
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CONFLICT);
    let get = client.get(format!("{path}/ses_test")).send().await.unwrap();
    assert_eq!(get.status(), StatusCode::CONFLICT);
    server.abort();
    upstream_task.abort();
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
            timeout: Some(std::time::Duration::from_millis(50)),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autostop_does_not_interrupt_an_admitted_agent_turn() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let stops = Arc::new(AtomicUsize::new(0));
    let finished = Arc::new(AtomicBool::new(false));
    let fail_admission = Arc::new(AtomicBool::new(false));
    let observations = Arc::new(AtomicUsize::new(0));
    let admission_started = Arc::new(tokio::sync::Notify::new());
    let finish_admission = Arc::new(tokio::sync::Notify::new());
    let box_info = || {
        json!({"box_id":STUB_BOX_ID,"name":null,"status":"running",
        "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
        "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512,"auto_resume":true})
    };
    let upstream = Router::new()
        .route(
            "/v1/boxes",
            get(move || async move { Json(json!({"boxes":[box_info()]})) }),
        )
        .route(
            "/v1/boxes/{id}",
            get(move || async move { Json(box_info()) }),
        )
        .route(
            "/v1/boxes/{id}/stop",
            post({
                let stops = Arc::clone(&stops);
                move || {
                    let stops = Arc::clone(&stops);
                    async move {
                        stops.fetch_add(1, Ordering::SeqCst);
                        Json(box_info())
                    }
                }
            }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}",
            get(|| async { Json(resource()) }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/turns",
            post({
                let admission_started = Arc::clone(&admission_started);
                let finish_admission = Arc::clone(&finish_admission);
                let fail_admission = Arc::clone(&fail_admission);
                move || {
                    let admission_started = Arc::clone(&admission_started);
                    let finish_admission = Arc::clone(&finish_admission);
                    let fail_admission = Arc::clone(&fail_admission);
                    async move {
                        admission_started.notify_one();
                        finish_admission.notified().await;
                        if fail_admission.load(Ordering::SeqCst) {
                            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":{"message":"uncertain","type":"InternalError","code":"internal"}})))
                        } else {
                            (StatusCode::CREATED, Json(turn()))
                        }
                    }
                }
            }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/turns/{turn}",
            get({
                let finished = Arc::clone(&finished);
                let observations = Arc::clone(&observations);
                move || {
                    let finished = Arc::clone(&finished);
                    let observations = Arc::clone(&observations);
                    async move {
                        if observations.fetch_add(1, Ordering::SeqCst) == 0 {
                            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({})))
                                .into_response();
                        }
                        let mut state = turn();
                        if finished.load(Ordering::SeqCst) {
                            state["status"] = json!("completed");
                        }
                        (StatusCode::OK, Json(state)).into_response()
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let state = Arc::new(state);
    state
        .set_lifecycle(
            STUB_BOX_ID,
            super::LifecyclePolicy {
                auto_stop: 60,
                auto_delete: 0,
            },
        )
        .await;
    let (url, server) = serve_router(Arc::clone(&state)).await;
    let second_url = url.clone();
    let third_url = url.clone();
    let request = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!(
                "{url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/turns"
            ))
            .json(&json!({"text":"long task"}))
            .send()
            .await
            .unwrap()
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        admission_started.notified(),
    )
    .await
    .unwrap();
    let now = std::time::Instant::now();
    state.last_activity.write().await.insert(
        STUB_BOX_ID.to_owned(),
        now - std::time::Duration::from_secs(120),
    );
    super::run_lifecycle_once(&state, now).await;
    assert_eq!(
        stops.load(Ordering::SeqCst),
        0,
        "AutoStop interrupted an admission"
    );
    finish_admission.notify_one();
    assert_eq!(request.await.unwrap().status(), StatusCode::CREATED);
    super::run_lifecycle_once(&state, now).await;
    assert_eq!(
        stops.load(Ordering::SeqCst),
        0,
        "AutoStop interrupted an admitted turn"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while observations.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    super::run_lifecycle_once(&state, now).await;
    assert_eq!(
        stops.load(Ordering::SeqCst),
        0,
        "observation error lost protection"
    );
    finished.store(true, Ordering::SeqCst);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while stops.load(Ordering::SeqCst) == 0 {
            super::run_lifecycle_once(&state, now).await;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("completed turn must eventually permit AutoStop");
    finished.store(false, Ordering::SeqCst);
    let before = observations.load(Ordering::SeqCst);
    let disconnected = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!(
                "{second_url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/turns"
            ))
            .json(&json!({"text":"disconnected task"}))
            .send()
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        admission_started.notified(),
    )
    .await
    .unwrap();
    disconnected.abort();
    finish_admission.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while observations.load(Ordering::SeqCst) == before {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("accepted work must remain observed after disconnect");
    state.last_activity.write().await.insert(
        STUB_BOX_ID.to_owned(),
        now - std::time::Duration::from_secs(120),
    );
    super::run_lifecycle_once(&state, now).await;
    assert_eq!(
        stops.load(Ordering::SeqCst),
        1,
        "disconnect lost protection"
    );
    state.forget_box(STUB_BOX_ID).await;
    state
        .set_lifecycle(
            STUB_BOX_ID,
            super::LifecyclePolicy {
                auto_stop: 60,
                auto_delete: 0,
            },
        )
        .await;
    state.last_activity.write().await.insert(
        STUB_BOX_ID.to_owned(),
        now - std::time::Duration::from_secs(120),
    );
    super::run_lifecycle_once(&state, now).await;
    assert_eq!(
        stops.load(Ordering::SeqCst),
        2,
        "removal must clear turn protection"
    );
    fail_admission.store(true, Ordering::SeqCst);
    let uncertain = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!(
                "{third_url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/turns"
            ))
            .json(&json!({"text":"uncertain task"}))
            .send()
            .await
            .unwrap()
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        admission_started.notified(),
    )
    .await
    .unwrap();
    finish_admission.notify_one();
    assert_eq!(
        uncertain.await.unwrap().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    state.last_activity.write().await.insert(
        STUB_BOX_ID.to_owned(),
        now - std::time::Duration::from_secs(120),
    );
    super::run_lifecycle_once(&state, now).await;
    assert_eq!(
        stops.load(Ordering::SeqCst),
        2,
        "uncertain admission lost protection"
    );
    server.abort();
    task.abort();
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
            match body["text"].as_str() {
                Some("hello") => assert!(body.get("options").is_none()),
                Some("hello-null") => assert_eq!(body.get("options").and_then(|options| options.get("data")), Some(&Value::Null)),
                _ => panic!("unexpected send request: {body}"),
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
            "hello-null",
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
