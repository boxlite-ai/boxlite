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
async fn idle_sse_heartbeats_do_not_become_agent_events() {
    use std::convert::Infallible;
    let upstream = Router::new()
        .route(
            "/v1/boxes/{id}",
            get(|| async {
                Json(json!({"box_id":STUB_BOX_ID,"name":null,"status":"running",
                "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
                "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512,"auto_resume":true}))
            }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}",
            get(|| async { Json(resource()) }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/events",
            get(|| async {
                let body = axum::body::Body::from_stream(futures::stream::pending::<
                    Result<axum::body::Bytes, Infallible>,
                >());
                ([(header::CONTENT_TYPE, "text/event-stream")], body)
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let (url, server) = serve_router(Arc::new(state)).await;
    let mut raw = reqwest::Client::new()
        .get(format!(
            "{url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/events"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(raw.status(), StatusCode::OK);
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(url)).unwrap();
    let sandbox = runtime.get(STUB_BOX_ID).await.unwrap().unwrap();
    let agent = sandbox.agents().get("ses_test").await.unwrap();
    let mut events = agent.events(Default::default()).await.unwrap();
    let chunk = tokio::time::timeout(std::time::Duration::from_secs(18), raw.chunk())
        .await
        .expect("idle serve stream did not emit a heartbeat")
        .unwrap()
        .unwrap();
    assert!(chunk.starts_with(b":"), "heartbeat must be an SSE comment");
    assert!(!String::from_utf8_lossy(&chunk).contains("id:"));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), events.next())
            .await
            .is_err(),
        "a heartbeat must not be delivered as an agent event"
    );
    server.abort();
    task.abort();
}

async fn rejected_turn_releases_protection(status: StatusCode) {
    let upstream = Router::new()
        .route(
            "/v1/boxes/{id}",
            get(|| async {
                Json(json!({"box_id":STUB_BOX_ID,"name":null,"status":"running",
                "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
                "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512,"auto_resume":true}))
            }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}",
            get(|| async { Json(resource()) }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/turns",
            post(move || async move { status }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let state = Arc::new(state);
    let (url, server) = serve_router(Arc::clone(&state)).await;
    let response = reqwest::Client::new()
        .post(format!(
            "{url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/turns"
        ))
        .json(&json!({"text":"task"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), status);
    assert!(
        !state.agent_turns.lock().await.contains_key(STUB_BOX_ID),
        "rejected turn retained AutoStop protection"
    );
    server.abort();
    task.abort();
}

#[tokio::test]
async fn conflict_rejection_releases_autostop_protection() {
    rejected_turn_releases_protection(StatusCode::CONFLICT).await;
}

#[tokio::test]
async fn resource_exhausted_rejection_releases_autostop_protection() {
    rejected_turn_releases_protection(StatusCode::TOO_MANY_REQUESTS).await;
}

#[tokio::test]
async fn unknown_turn_releases_autostop_protection() {
    let upstream = Router::new()
        .route(
            "/v1/boxes/{id}",
            get(|| async {
                Json(json!({"box_id":STUB_BOX_ID,"name":null,"status":"running",
                "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
                "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512,"auto_resume":true}))
            }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}",
            get(|| async { Json(resource()) }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/turns",
            post(|| async { (StatusCode::CREATED, Json(turn())) }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/turns/{turn}",
            get(|| async {
                let mut state = turn();
                state["status"] = json!("unknown");
                Json(state)
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let state = Arc::new(state);
    let (url, server) = serve_router(Arc::clone(&state)).await;
    let response = reqwest::Client::new()
        .post(format!(
            "{url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/turns"
        ))
        .json(&json!({"text":"task"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while state.agent_turns.lock().await.contains_key(STUB_BOX_ID) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("unknown terminal turn retained AutoStop protection");
    server.abort();
    task.abort();
}

#[tokio::test]
async fn uncertain_admission_protection_expires() {
    let upstream = Router::new()
        .route(
            "/v1/boxes/{id}",
            get(|| async {
                Json(json!({"box_id":STUB_BOX_ID,"name":null,"status":"running",
                "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
                "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512,"auto_resume":true}))
            }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}",
            get(|| async { Json(resource()) }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/turns",
            post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = lifecycle_state();
    state.runtime =
        BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let state = Arc::new(state);
    let (url, server) = serve_router(Arc::clone(&state)).await;
    let response = reqwest::Client::new()
        .post(format!(
            "{url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/turns"
        ))
        .json(&json!({"text":"task"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(state.agent_turns.lock().await.contains_key(STUB_BOX_ID));
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(301)).await;
    tokio::task::yield_now().await;
    assert!(
        !state.agent_turns.lock().await.contains_key(STUB_BOX_ID),
        "uncertain admission retained protection after its grace period"
    );
    server.abort();
    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_one_box_does_not_block_another_box_admission() {
    let stop_started = Arc::new(tokio::sync::Notify::new());
    let finish_stop = Arc::new(tokio::sync::Notify::new());
    let box_info = |id: &str| {
        json!({"box_id":id,"name":null,"status":"running",
        "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
        "pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512,"auto_resume":true})
    };
    let upstream = Router::new()
        .route(
            "/v1/boxes",
            get(move || async move { Json(json!({"boxes":[box_info(STUB_BOX_ID)]})) }),
        )
        .route(
            "/v1/boxes/{id}",
            get(
                move |axum::extract::Path(id): axum::extract::Path<String>| async move {
                    Json(box_info(&id))
                },
            ),
        )
        .route(
            "/v1/boxes/{id}/stop",
            post({
                let started = Arc::clone(&stop_started);
                let finish = Arc::clone(&finish_stop);
                move || {
                    let started = Arc::clone(&started);
                    let finish = Arc::clone(&finish);
                    async move {
                        started.notify_one();
                        finish.notified().await;
                        Json(box_info(STUB_BOX_ID))
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
            post(|| async { (StatusCode::CREATED, Json(turn())) }),
        )
        .route(
            "/v1/boxes/{id}/agents/{agent}/turns/{turn}",
            get(|| async { Json(turn()) }),
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
    let now = std::time::Instant::now();
    state.last_activity.write().await.insert(
        STUB_BOX_ID.into(),
        now - std::time::Duration::from_secs(120),
    );
    let (url, server) = serve_router(Arc::clone(&state)).await;
    let sweep = tokio::spawn({
        let state = Arc::clone(&state);
        async move { super::run_lifecycle_once(&state, now).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), stop_started.notified())
        .await
        .unwrap();
    let same_url = url.clone();
    let mut same_box = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!(
                "{same_url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/turns"
            ))
            .json(&json!({"text":"same box"}))
            .send()
            .await
            .unwrap()
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut same_box)
            .await
            .is_err(),
        "admission for the stopping Box must wait"
    );
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        reqwest::Client::new()
            .post(format!("{url}/v1/boxes/other-box/agents/ses_test/turns"))
            .json(&json!({"text":"task"}))
            .send(),
    )
    .await;
    finish_stop.notify_one();
    sweep.await.unwrap();
    assert_eq!(same_box.await.unwrap().status(), StatusCode::CREATED);
    assert_eq!(
        response
            .expect("another Box admission was blocked by AutoStop")
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    server.abort();
    task.abort();
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

struct AutoStopFixture {
    state: Arc<super::AppState>,
    url: String,
    stops: Arc<std::sync::atomic::AtomicUsize>,
    finished: Arc<std::sync::atomic::AtomicBool>,
    fail_admission: Arc<std::sync::atomic::AtomicBool>,
    observations: Arc<std::sync::atomic::AtomicUsize>,
    running: Arc<std::sync::atomic::AtomicBool>,
    run: Arc<std::sync::atomic::AtomicUsize>,
    invalidated: Arc<std::sync::atomic::AtomicBool>,
    starts: Arc<std::sync::atomic::AtomicUsize>,
    hold_observation: Arc<std::sync::atomic::AtomicBool>,
    observation_started: Arc<tokio::sync::Notify>,
    finish_observation: Arc<tokio::sync::Notify>,
    admission_started: Arc<tokio::sync::Notify>,
    finish_admission: Arc<tokio::sync::Notify>,
    server: tokio::task::JoinHandle<()>,
    upstream: tokio::task::JoinHandle<()>,
}

impl AutoStopFixture {
    async fn new() -> Self {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let stops = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicBool::new(false));
        let fail_admission = Arc::new(AtomicBool::new(false));
        let observations = Arc::new(AtomicUsize::new(0));
        let running = Arc::new(AtomicBool::new(true));
        let run = Arc::new(AtomicUsize::new(1));
        let invalidated = Arc::new(AtomicBool::new(false));
        let starts = Arc::new(AtomicUsize::new(0));
        let hold_observation = Arc::new(AtomicBool::new(false));
        let observation_started = Arc::new(tokio::sync::Notify::new());
        let finish_observation = Arc::new(tokio::sync::Notify::new());
        let admission_started = Arc::new(tokio::sync::Notify::new());
        let finish_admission = Arc::new(tokio::sync::Notify::new());
        fn box_info(running: bool, run: usize) -> Value {
            json!({"box_id":STUB_BOX_ID,"name":"friendly-box","status":if running { "running" } else { "stopped" },
            "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z",
            "pid":run,"image":"alpine:latest","cpus":1,"memory_mib":512,"auto_resume":true})
        }
        let app = Router::new()
            .route("/v1/boxes", get({
                let running = Arc::clone(&running);
                let run = Arc::clone(&run);
                move || { let running = Arc::clone(&running); let run = Arc::clone(&run); async move {
                    Json(json!({"boxes":[box_info(running.load(Ordering::SeqCst), run.load(Ordering::SeqCst))]}))
                }}
            }))
            .route("/v1/boxes/{id}", get({
                let running = Arc::clone(&running);
                let run = Arc::clone(&run);
                move || { let running = Arc::clone(&running); let run = Arc::clone(&run); async move {
                    Json(box_info(running.load(Ordering::SeqCst), run.load(Ordering::SeqCst)))
                }}
            }))
            .route("/v1/boxes/{id}/start", post({
                let running = Arc::clone(&running);
                let starts = Arc::clone(&starts);
                let run = Arc::clone(&run);
                move || { let running = Arc::clone(&running); let starts = Arc::clone(&starts);
                    let run = Arc::clone(&run); async move {
                    starts.fetch_add(1, Ordering::SeqCst);
                    running.store(true, Ordering::SeqCst);
                    let next_run = run.fetch_add(1, Ordering::SeqCst) + 1;
                    Json(box_info(true, next_run))
                }}
            }))
            .route("/v1/boxes/{id}/stop", post({
                let stops = Arc::clone(&stops);
                let running = Arc::clone(&running);
                let invalidated = Arc::clone(&invalidated);
                let run = Arc::clone(&run);
                move || { let stops = Arc::clone(&stops); let running = Arc::clone(&running);
                    let invalidated = Arc::clone(&invalidated); let run = Arc::clone(&run); async move {
                    stops.fetch_add(1, Ordering::SeqCst);
                    running.store(false, Ordering::SeqCst);
                    invalidated.store(true, Ordering::SeqCst);
                    Json(box_info(false, run.load(Ordering::SeqCst)))
                }}
            }))
            .route("/v1/boxes/{id}/agents/{agent}", get(|| async { Json(resource()) }))
            .route("/v1/boxes/{id}/agents/{agent}/turns", post({
                let started = Arc::clone(&admission_started);
                let finish = Arc::clone(&finish_admission);
                let fail = Arc::clone(&fail_admission);
                move || { let started = Arc::clone(&started); let finish = Arc::clone(&finish);
                    let fail = Arc::clone(&fail); async move {
                        started.notify_one();
                        finish.notified().await;
                        if fail.load(Ordering::SeqCst) {
                            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":{"message":"uncertain","type":"InternalError","code":"internal"}})))
                        } else { (StatusCode::CREATED, Json(turn())) }
                    }
                }
            }))
            .route("/v1/boxes/{id}/agents/{agent}/turns/{turn}", get({
                let finished = Arc::clone(&finished);
                let observations = Arc::clone(&observations);
                let running = Arc::clone(&running);
                let invalidated = Arc::clone(&invalidated);
                let starts = Arc::clone(&starts);
                let hold = Arc::clone(&hold_observation);
                let started = Arc::clone(&observation_started);
                let finish = Arc::clone(&finish_observation);
                move || { let finished = Arc::clone(&finished); let observations = Arc::clone(&observations);
                    let running = Arc::clone(&running); let invalidated = Arc::clone(&invalidated);
                    let starts = Arc::clone(&starts); let hold = Arc::clone(&hold);
                    let started = Arc::clone(&started); let finish = Arc::clone(&finish);
                    async move {
                        let observation = observations.fetch_add(1, Ordering::SeqCst);
                        // An agent lookup can resume the service; metadata reads must not.
                        if !running.swap(true, Ordering::SeqCst) { starts.fetch_add(1, Ordering::SeqCst); }
                        if hold.swap(false, Ordering::SeqCst) {
                            started.notify_one();
                            finish.notified().await;
                        }
                        if invalidated.load(Ordering::SeqCst) {
                            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))).into_response();
                        }
                        if observation == 0 {
                            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))).into_response();
                        }
                        let mut state = turn();
                        if finished.load(Ordering::SeqCst) { state["status"] = json!("completed"); }
                        (StatusCode::OK, Json(state)).into_response()
                    }
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
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
        Self {
            state,
            url,
            stops,
            finished,
            fail_admission,
            observations,
            running,
            run,
            invalidated,
            starts,
            hold_observation,
            observation_started,
            finish_observation,
            admission_started,
            finish_admission,
            server,
            upstream,
        }
    }

    async fn start(&self) -> tokio::task::JoinHandle<reqwest::Result<reqwest::Response>> {
        let url = self.url.clone();
        let request = tokio::spawn(async move {
            reqwest::Client::new()
                .post(format!(
                    "{url}/v1/boxes/{STUB_BOX_ID}/agents/ses_test/turns"
                ))
                .json(&json!({"text":"long task"}))
                .send()
                .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.admission_started.notified(),
        )
        .await
        .unwrap();
        request
    }

    async fn sweep(&self) {
        let now = std::time::Instant::now();
        let mut activity = self.state.last_activity.write().await;
        for timestamp in activity.values_mut() {
            *timestamp = now - std::time::Duration::from_secs(120);
        }
        activity.insert(
            STUB_BOX_ID.into(),
            now - std::time::Duration::from_secs(120),
        );
        drop(activity);
        super::run_lifecycle_once(&self.state, now).await;
    }

    async fn accept(&self) {
        let request = self.start().await;
        self.finish_admission.notify_one();
        assert_eq!(
            request.await.unwrap().unwrap().status(),
            StatusCode::CREATED
        );
    }

    async fn wait_for_observations(&self, count: usize) {
        use std::sync::atomic::Ordering;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while self.observations.load(Ordering::SeqCst) < count {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }

    fn stops(&self) -> usize {
        self.stops.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Drop for AutoStopFixture {
    fn drop(&mut self) {
        self.server.abort();
        self.upstream.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autostop_spares_an_admission_in_progress() {
    let fixture = AutoStopFixture::new().await;
    let request = fixture.start().await;
    fixture.sweep().await;
    assert_eq!(fixture.stops(), 0);
    fixture.finish_admission.notify_one();
    assert_eq!(
        request.await.unwrap().unwrap().status(),
        StatusCode::CREATED
    );
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

#[tokio::test]
async fn rest_review_stop_by_name_releases_turn_protection_after_restart() {
    use std::sync::atomic::Ordering;
    let fixture = AutoStopFixture::new().await;
    fixture.hold_observation.store(true, Ordering::SeqCst);
    fixture.accept().await;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.observation_started.notified(),
    )
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let stopped = client
        .post(format!("{}/v1/boxes/friendly-box/stop", fixture.url))
        .send()
        .await
        .unwrap();
    assert_eq!(stopped.status(), StatusCode::OK);
    assert!(
        !fixture
            .state
            .agent_turns
            .lock()
            .await
            .contains_key(STUB_BOX_ID),
        "stop by name retained the canonical Box reservation"
    );
    let restarted = client
        .post(format!("{}/v1/boxes/friendly-box/start", fixture.url))
        .send()
        .await
        .unwrap();
    assert_eq!(restarted.status(), StatusCode::OK);
    fixture.finish_observation.notify_one();
    fixture.sweep().await;
    assert_eq!(
        fixture.stops(),
        2,
        "a restarted Box inherited stale turn protection"
    );
}

#[tokio::test]
async fn rest_review_observer_releases_a_stopped_run_without_resuming_it() {
    use std::sync::atomic::Ordering;
    let fixture = AutoStopFixture::new().await;
    fixture.hold_observation.store(true, Ordering::SeqCst);
    fixture.accept().await;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.observation_started.notified(),
    )
    .await
    .unwrap();
    fixture.running.store(false, Ordering::SeqCst);
    fixture.invalidated.store(true, Ordering::SeqCst);
    fixture.finish_observation.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture
            .state
            .agent_turns
            .lock()
            .await
            .contains_key(STUB_BOX_ID)
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("observer retained protection after the Box run stopped");
    assert_eq!(
        fixture.starts.load(Ordering::SeqCst),
        0,
        "observer resumed a stopped Box"
    );
    assert!(!fixture.running.load(Ordering::SeqCst));
}

#[tokio::test]
async fn rest_review_restart_before_first_observation_releases_the_old_run() {
    use std::sync::atomic::Ordering;
    let fixture = AutoStopFixture::new().await;
    let request = fixture.start().await;
    fixture.running.store(false, Ordering::SeqCst);
    fixture.invalidated.store(true, Ordering::SeqCst);
    fixture.run.fetch_add(1, Ordering::SeqCst);
    fixture.running.store(true, Ordering::SeqCst);
    fixture.finish_admission.notify_one();
    assert_eq!(
        request.await.unwrap().unwrap().status(),
        StatusCode::CREATED
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture
            .state
            .agent_turns
            .lock()
            .await
            .contains_key(STUB_BOX_ID)
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a replacement run retained the old reservation");
    assert_eq!(
        fixture.observations.load(Ordering::SeqCst),
        0,
        "the old agent handle was polled in a replacement run"
    );
    fixture.sweep().await;
    assert_eq!(
        fixture.stops(),
        1,
        "stale protection prevented AutoStop after restart"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autostop_spares_an_accepted_turn() {
    let fixture = AutoStopFixture::new().await;
    fixture.accept().await;
    fixture.sweep().await;
    assert_eq!(fixture.stops(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autostop_retains_protection_after_observation_error() {
    let fixture = AutoStopFixture::new().await;
    fixture.accept().await;
    fixture.wait_for_observations(2).await;
    fixture.sweep().await;
    assert_eq!(fixture.stops(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autostop_resumes_after_turn_completion() {
    let fixture = AutoStopFixture::new().await;
    fixture.accept().await;
    fixture
        .finished
        .store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture.stops() == 0 {
            fixture.sweep().await;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("completed turn must eventually permit AutoStop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autostop_preserves_disconnected_admission() {
    let fixture = AutoStopFixture::new().await;
    let request = fixture.start().await;
    request.abort();
    assert!(
        request
            .await
            .expect_err("client must be cancelled")
            .is_cancelled()
    );
    fixture.finish_admission.notify_one();
    fixture.wait_for_observations(1).await;
    fixture.sweep().await;
    assert_eq!(fixture.stops(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autostop_removal_clears_turn_protection() {
    let fixture = AutoStopFixture::new().await;
    fixture.accept().await;
    fixture.state.forget_box(STUB_BOX_ID).await;
    fixture
        .state
        .set_lifecycle(
            STUB_BOX_ID,
            super::LifecyclePolicy {
                auto_stop: 60,
                auto_delete: 0,
            },
        )
        .await;
    fixture.sweep().await;
    assert_eq!(fixture.stops(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autostop_protects_an_uncertain_admission_during_grace() {
    let fixture = AutoStopFixture::new().await;
    fixture
        .fail_admission
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let request = fixture.start().await;
    fixture.finish_admission.notify_one();
    assert_eq!(
        request.await.unwrap().unwrap().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    fixture.sweep().await;
    assert_eq!(fixture.stops(), 0);
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

#[tokio::test]
async fn agent_routes_reject_invalid_bodies_before_dispatch() {
    let (url, server) = serve_router(Arc::new(lifecycle_state())).await;
    let client = reqwest::Client::new();
    for (suffix, body) in [
        ("", json!({"agent":"opencode","options":{"cwd":null}})),
        ("", json!({"agent":"opencode","options":{"config":null}})),
        (
            "",
            json!({"agent":"opencode","options":{"config":{"extra":true}}}),
        ),
        ("/ses_test/close", json!({"extra":true})),
        (
            "/ses_test/turns",
            json!({"text":"hello","options":{"mode":"invalid"}}),
        ),
        (
            "/ses_test/turns",
            json!({"text":"hello","options":{"mode":null}}),
        ),
        (
            "/ses_test/requests/req/respond",
            json!({"response":{"type":"unknown"}}),
        ),
        (
            "/ses_test/requests/req/respond",
            json!({"response":{"type":"permission","approved":null}}),
        ),
        (
            "/ses_test/turns/msg/steer",
            json!({"text":"hi","extra":true}),
        ),
        ("/ses_test/turns/msg/interrupt", json!({"extra":true})),
    ] {
        let response = client
            .post(format!("{url}/v1/boxes/{STUB_BOX_ID}/agents{suffix}"))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{suffix}: {body}"
        );
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["error"]["code"], "invalid_argument");
    }
    server.abort();
}

#[tokio::test]
async fn agent_routes_validate_idempotency_key_boundaries_before_dispatch() {
    let (url, server) = serve_router(Arc::new(lifecycle_state())).await;
    let client = reqwest::Client::new();
    let path = format!("{url}/v1/boxes/{STUB_BOX_ID}/agents");
    let invalid_keys = [
        Vec::new(),
        vec![b'x'; 257],
        b"has space".to_vec(),
        vec![0xff],
    ];
    for bytes in invalid_keys {
        let value = axum::http::HeaderValue::from_bytes(&bytes).unwrap();
        let response = client
            .post(&path)
            .header("Idempotency-Key", value)
            .json(&json!({"agent":"opencode"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{bytes:?}");
    }
    let duplicate = client
        .post(&path)
        .header("Idempotency-Key", "one")
        .header("Idempotency-Key", "two")
        .json(&json!({"agent":"opencode"}))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
    let boundary = client
        .post(&path)
        .header("Idempotency-Key", "x".repeat(256))
        .json(&json!({"agent":"opencode","options":{"cwd":"/work","config":{"model":"provider/model"}}}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        boundary.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "a valid 256-byte key must reach the unavailable backend"
    );
    let error: Value = boundary.json().await.unwrap();
    assert_eq!(error["error"]["code"], "network_unavailable");
    server.abort();
}
