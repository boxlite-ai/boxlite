//! `boxlite serve` — long-running REST API server.
//!
//! Holds a single BoxliteRuntime and exposes the full REST API
//! over HTTP so that `Boxlite.rest()` clients can connect.

mod handlers;
mod types;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::http::StatusCode;
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use clap::Args;
use tokio::sync::RwLock;

use boxlite::{
    BoxCommand, BoxInfo, BoxOptions, BoxliteRuntime, ExecStdin, Execution, LiteBox, RootfsSpec,
};

use crate::cli::GlobalFlags;

use self::types::{BoxResponse, CreateBoxRequest, ErrorBody, ErrorDetail, ExecRequest};

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
    stdin: tokio::sync::Mutex<Option<ExecStdin>>,
    started_at: Instant,
}

impl ActiveExecution {
    fn new(execution: Execution, stdin: Option<ExecStdin>) -> Self {
        Self {
            execution,
            stdin: tokio::sync::Mutex::new(stdin),
            started_at: Instant::now(),
        }
    }
}

/// Internal message type for multiplexing stdout/stderr SSE events.
enum SseItem {
    Event(Event),
    StreamDone,
}

// ============================================================================
// Error Constants
// ============================================================================

const ERROR_AUTH: &str = "AuthError";

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
    use handlers::{advanced, auth, boxes, config, executions, files, metrics, snapshots};

    Router::new()
        // Auth & config (no tenant prefix)
        .route("/v1/oauth/tokens", post(auth::oauth_token))
        .route("/v1/config", get(config::get_config))
        // Runtime metrics
        .route("/v1/default/metrics", get(metrics::runtime_metrics))
        // Box CRUD (import first — static path before param path)
        .route("/v1/default/boxes/import", post(advanced::import_box))
        .route(
            "/v1/default/boxes",
            post(boxes::create_box).get(boxes::list_boxes),
        )
        .route(
            "/v1/default/boxes/{box_id}",
            get(boxes::get_box)
                .delete(boxes::remove_box)
                .head(boxes::head_box),
        )
        // Box lifecycle
        .route(
            "/v1/default/boxes/{box_id}/start",
            post(boxes::start_box),
        )
        .route(
            "/v1/default/boxes/{box_id}/stop",
            post(boxes::stop_box),
        )
        // Box metrics
        .route(
            "/v1/default/boxes/{box_id}/metrics",
            get(metrics::box_metrics),
        )
        // Execution
        .route(
            "/v1/default/boxes/{box_id}/exec",
            post(executions::start_execution),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}",
            get(executions::get_execution),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}/output",
            get(executions::stream_execution_output),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}/input",
            post(executions::send_input),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}/signal",
            post(executions::send_signal),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}/resize",
            post(executions::resize_tty),
        )
        // Files
        .route(
            "/v1/default/boxes/{box_id}/files",
            put(files::upload_files).get(files::download_files),
        )
        // Snapshots
        .route(
            "/v1/default/boxes/{box_id}/snapshots",
            post(snapshots::create_snapshot).get(snapshots::list_snapshots),
        )
        .route(
            "/v1/default/boxes/{box_id}/snapshots/{name}",
            get(snapshots::get_snapshot).delete(snapshots::delete_snapshot),
        )
        .route(
            "/v1/default/boxes/{box_id}/snapshots/{name}/restore",
            post(snapshots::restore_snapshot),
        )
        // Clone & export
        .route(
            "/v1/default/boxes/{box_id}/clone",
            post(advanced::clone_box),
        )
        .route(
            "/v1/default/boxes/{box_id}/export",
            post(advanced::export_box),
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
