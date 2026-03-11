//! `boxlite serve` — long-running REST API server.
//!
//! Holds a single BoxliteRuntime and exposes box lifecycle + exec operations
//! over HTTP so that multiple callers share the same runtime (no lock contention).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use clap::Args;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use boxlite::{BoxCommand, BoxInfo, BoxOptions, BoxliteRuntime, Execution, LiteBox, RootfsSpec};

use crate::cli::GlobalFlags;

// ============================================================================
// CLI Args
// ============================================================================

#[derive(Args, Debug)]
pub struct ServeArgs {
    /// Port to listen on
    #[arg(long, default_value = "8100")]
    pub port: u16,

    /// Host/address to bind to
    #[arg(long, default_value = "0.0.0.0")]
    pub host: String,
}

// ============================================================================
// Shared State
// ============================================================================

struct AppState {
    runtime: BoxliteRuntime,
    /// Cached box handles (box_id -> Arc<LiteBox>).
    boxes: RwLock<HashMap<String, Arc<LiteBox>>>,
    /// Active executions (execution_id -> ActiveExecution).
    executions: RwLock<HashMap<String, ActiveExecution>>,
}

struct ActiveExecution {
    execution: Execution,
    started_at: Instant,
}

/// Internal message type for multiplexing stdout/stderr SSE events.
enum SseItem {
    Event(Event),
    StreamDone,
}

// ============================================================================
// Wire Types (request/response JSON)
// ============================================================================

#[derive(Deserialize)]
struct CreateBoxRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    rootfs_path: Option<String>,
    #[serde(default)]
    cpus: Option<u8>,
    #[serde(default)]
    memory_mib: Option<u32>,
    #[serde(default)]
    disk_size_gb: Option<u64>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    entrypoint: Option<Vec<String>>,
    #[serde(default)]
    cmd: Option<Vec<String>>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    auto_remove: Option<bool>,
    #[serde(default)]
    detach: Option<bool>,
}

#[derive(Serialize)]
struct BoxResponse {
    box_id: String,
    name: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    pid: Option<u32>,
    image: String,
    cpus: u8,
    memory_mib: u32,
    labels: HashMap<String, String>,
}

#[derive(Serialize)]
struct ListBoxesResponse {
    boxes: Vec<BoxResponse>,
}

#[derive(Deserialize)]
struct ExecRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    stdin: Option<String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    timeout_seconds: Option<f64>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    tty: bool,
}

#[derive(Serialize)]
struct ExecResponse {
    execution_id: String,
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    message: String,
    #[serde(rename = "type")]
    error_type: String,
    code: u16,
}

#[derive(Serialize)]
struct ConfigResponse {
    defaults: ConfigDefaults,
}

#[derive(Serialize)]
struct ConfigDefaults {
    cpus: u8,
    memory_mib: u32,
    disk_size_gb: u64,
}

// ============================================================================
// Conversions
// ============================================================================

fn box_info_to_response(info: &BoxInfo) -> BoxResponse {
    BoxResponse {
        box_id: info.id.to_string(),
        name: info.name.clone(),
        status: info.status.as_str().to_string(),
        created_at: info.created_at.to_rfc3339(),
        updated_at: info.last_updated.to_rfc3339(),
        pid: info.pid,
        image: info.image.clone(),
        cpus: info.cpus,
        memory_mib: info.memory_mib,
        labels: info.labels.clone(),
    }
}

fn build_box_options(req: &CreateBoxRequest) -> BoxOptions {
    let rootfs = if let Some(ref path) = req.rootfs_path {
        RootfsSpec::RootfsPath(path.clone())
    } else {
        RootfsSpec::Image(req.image.clone().unwrap_or_else(|| "alpine:latest".into()))
    };

    let env: Vec<(String, String)> = req
        .env
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    BoxOptions {
        rootfs,
        cpus: req.cpus,
        memory_mib: req.memory_mib,
        disk_size_gb: req.disk_size_gb,
        working_dir: req.working_dir.clone(),
        env,
        entrypoint: req.entrypoint.clone(),
        cmd: req.cmd.clone(),
        user: req.user.clone(),
        auto_remove: req.auto_remove.unwrap_or(false),
        detach: req.detach.unwrap_or(true),
        ..Default::default()
    }
}

fn build_box_command(req: &ExecRequest) -> BoxCommand {
    let mut cmd = BoxCommand::new(&req.command).args(req.args.iter().map(String::as_str));

    if let Some(ref env_map) = req.env {
        for (k, v) in env_map {
            cmd = cmd.env(k, v);
        }
    }
    if let Some(ref wd) = req.working_dir {
        cmd = cmd.working_dir(wd);
    }
    if req.tty {
        cmd = cmd.tty(true);
    }
    if let Some(secs) = req.timeout_seconds {
        cmd = cmd.timeout(std::time::Duration::from_secs_f64(secs));
    }
    cmd
}

// ============================================================================
// Error Helpers
// ============================================================================

fn error_response(status: StatusCode, message: impl Into<String>, error_type: &str) -> Response {
    let body = ErrorBody {
        error: ErrorDetail {
            message: message.into(),
            error_type: error_type.to_string(),
            code: status.as_u16(),
        },
    };
    (status, Json(body)).into_response()
}

fn classify_boxlite_error(err: &boxlite::BoxliteError) -> (StatusCode, &'static str) {
    let msg = err.to_string().to_lowercase();
    if msg.contains("not found") {
        (StatusCode::NOT_FOUND, "NotFoundError")
    } else if msg.contains("already") || msg.contains("conflict") {
        (StatusCode::CONFLICT, "ConflictError")
    } else if msg.contains("unsupported") {
        (StatusCode::BAD_REQUEST, "UnsupportedError")
    } else {
        (StatusCode::INTERNAL_SERVER_ERROR, "InternalError")
    }
}

// ============================================================================
// Handlers
// ============================================================================

async fn get_config() -> Json<ConfigResponse> {
    Json(ConfigResponse {
        defaults: ConfigDefaults {
            cpus: 2,
            memory_mib: 512,
            disk_size_gb: 10,
        },
    })
}

async fn create_box(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateBoxRequest>,
) -> Response {
    let name = req.name.clone();
    let options = build_box_options(&req);

    let litebox = match state.runtime.create(options, name).await {
        Ok(b) => b,
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            return error_response(status, e.to_string(), etype);
        }
    };

    let info = litebox.info();
    let box_id = info.id.to_string();
    let resp = box_info_to_response(&info);

    state.boxes.write().await.insert(box_id, Arc::new(litebox));

    (StatusCode::CREATED, Json(resp)).into_response()
}

async fn list_boxes(State(state): State<Arc<AppState>>) -> Response {
    match state.runtime.list_info().await {
        Ok(infos) => {
            let boxes = infos.iter().map(box_info_to_response).collect();
            Json(ListBoxesResponse { boxes }).into_response()
        }
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

async fn get_box(State(state): State<Arc<AppState>>, Path(box_id): Path<String>) -> Response {
    match state.runtime.get_info(&box_id).await {
        Ok(Some(info)) => Json(box_info_to_response(&info)).into_response(),
        Ok(None) => error_response(
            StatusCode::NOT_FOUND,
            format!("box not found: {box_id}"),
            "NotFoundError",
        ),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

async fn start_box(State(state): State<Arc<AppState>>, Path(box_id): Path<String>) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    if let Err(e) = litebox.start().await {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    let info = litebox.info();
    Json(box_info_to_response(&info)).into_response()
}

async fn stop_box(State(state): State<Arc<AppState>>, Path(box_id): Path<String>) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    if let Err(e) = litebox.stop().await {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    let info = litebox.info();
    Json(box_info_to_response(&info)).into_response()
}

async fn remove_box(State(state): State<Arc<AppState>>, Path(box_id): Path<String>) -> Response {
    // Evict from cache first
    state.boxes.write().await.remove(&box_id);

    match state.runtime.remove(&box_id, true).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

async fn start_execution(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Json(req): Json<ExecRequest>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let stdin_data = req.stdin.clone();
    let cmd = build_box_command(&req);

    let mut execution = match litebox.exec(cmd).await {
        Ok(e) => e,
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            return error_response(status, e.to_string(), etype);
        }
    };

    // Write stdin and close it before storing the execution
    if let Some(ref data) = stdin_data
        && let Some(mut stdin) = execution.stdin()
    {
        let _ = stdin.write_all(data.as_bytes()).await;
        stdin.close();
    }

    let exec_id = execution.id().clone();

    state.executions.write().await.insert(
        exec_id.clone(),
        ActiveExecution {
            execution,
            started_at: Instant::now(),
        },
    );

    (
        StatusCode::CREATED,
        Json(ExecResponse {
            execution_id: exec_id,
        }),
    )
        .into_response()
}

async fn stream_execution_output(
    State(state): State<Arc<AppState>>,
    Path((_box_id, exec_id)): Path<(String, String)>,
) -> Response {
    // Take the execution out of the map (streams can only be consumed once)
    let active = match state.executions.write().await.remove(&exec_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                format!("execution not found: {exec_id}"),
                "NotFoundError",
            );
        }
    };

    let started_at = active.started_at;
    let mut execution = active.execution;

    // Take stdout/stderr streams (can only be called once)
    let stdout = execution.stdout();
    let stderr = execution.stderr();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SseItem>();

    // Spawn producer tasks for stdout and stderr
    let mut stream_count = 0u32;
    if let Some(mut out) = stdout {
        stream_count += 1;
        let tx_out = tx.clone();
        tokio::spawn(async move {
            let b64 = base64::engine::general_purpose::STANDARD;
            while let Some(line) = out.next().await {
                let encoded = b64.encode(line.as_bytes());
                let data = serde_json::json!({"data": encoded}).to_string();
                let event = Event::default().event("stdout").data(data);
                if tx_out.send(SseItem::Event(event)).is_err() {
                    break;
                }
            }
            let _ = tx_out.send(SseItem::StreamDone);
        });
    }

    if let Some(mut err_stream) = stderr {
        stream_count += 1;
        let tx_err = tx.clone();
        tokio::spawn(async move {
            let b64 = base64::engine::general_purpose::STANDARD;
            while let Some(line) = err_stream.next().await {
                let encoded = b64.encode(line.as_bytes());
                let data = serde_json::json!({"data": encoded}).to_string();
                let event = Event::default().event("stderr").data(data);
                if tx_err.send(SseItem::Event(event)).is_err() {
                    break;
                }
            }
            let _ = tx_err.send(SseItem::StreamDone);
        });
    }

    // Drop original sender so rx closes when all producers finish
    drop(tx);

    let stream = async_stream::stream! {
        // Multiplex stdout/stderr events
        let mut done = 0u32;
        while done < stream_count {
            match rx.recv().await {
                Some(SseItem::Event(event)) => {
                    yield Ok::<_, std::convert::Infallible>(event);
                }
                Some(SseItem::StreamDone) => {
                    done += 1;
                }
                None => break,
            }
        }

        // Wait for exit
        let result = execution.wait().await;
        let elapsed_ms = started_at.elapsed().as_millis() as u64;

        let (exit_code, _error_message) = match result {
            Ok(r) => (r.exit_code, r.error_message),
            Err(e) => (-1, Some(e.to_string())),
        };

        let exit_data = serde_json::json!({
            "exit_code": exit_code,
            "duration_ms": elapsed_ms,
        })
        .to_string();

        yield Ok(Event::default().event("exit").data(exit_data));
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

// ============================================================================
// Box Handle Cache Helper
// ============================================================================

async fn get_or_fetch_box(state: &AppState, box_id: &str) -> Result<Arc<LiteBox>, Response> {
    // Check cache first
    if let Some(b) = state.boxes.read().await.get(box_id) {
        return Ok(Arc::clone(b));
    }

    // Fetch from runtime
    match state.runtime.get(box_id).await {
        Ok(Some(b)) => {
            let id = b.info().id.to_string();
            let arc = Arc::new(b);
            state.boxes.write().await.insert(id, Arc::clone(&arc));
            Ok(arc)
        }
        Ok(None) => Err(error_response(
            StatusCode::NOT_FOUND,
            format!("box not found: {box_id}"),
            "NotFoundError",
        )),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            Err(error_response(status, e.to_string(), etype))
        }
    }
}

// ============================================================================
// Router
// ============================================================================

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/config", get(get_config))
        .route("/v1/local/boxes", post(create_box))
        .route("/v1/local/boxes", get(list_boxes))
        .route("/v1/local/boxes/{box_id}", get(get_box))
        .route("/v1/local/boxes/{box_id}", delete(remove_box))
        .route("/v1/local/boxes/{box_id}/start", post(start_box))
        .route("/v1/local/boxes/{box_id}/stop", post(stop_box))
        .route("/v1/local/boxes/{box_id}/exec", post(start_execution))
        .route(
            "/v1/local/boxes/{box_id}/executions/{exec_id}/output",
            get(stream_execution_output),
        )
        .with_state(state)
}

// ============================================================================
// Entry Point
// ============================================================================

pub async fn execute(args: ServeArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;

    let state = Arc::new(AppState {
        runtime,
        boxes: RwLock::new(HashMap::new()),
        executions: RwLock::new(HashMap::new()),
    });

    let app = build_router(state.clone());
    let addr = format!("{}:{}", args.host, args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    tracing::info!("boxlite serve listening on {}", addr);
    eprintln!("BoxLite REST API server listening on http://{addr}");

    // Graceful shutdown on ctrl-c
    let shutdown_state = state.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down...");
            eprintln!("\nShutting down...");
            let _ = shutdown_state.runtime.shutdown(Some(10)).await;
        })
        .await?;

    Ok(())
}
