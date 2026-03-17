//! Coordinator role — REST API gateway that dispatches to workers via gRPC.

pub mod handlers;
pub mod state;

use std::sync::Arc;

use axum::Router;
use axum::routing::{delete, get, post};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::coordinator::handlers::{admin, proxy};
use crate::coordinator::state::CoordinatorState;
use crate::scheduler::LeastLoadedScheduler;
use crate::store::StateStore;
use crate::store::sqlite::SqliteStateStore;

#[derive(OpenApi)]
#[openapi(
    paths(
        admin::register_worker,
        admin::list_workers,
        admin::remove_worker,
        admin::worker_heartbeat,
    ),
    components(schemas(
        admin::RegisterWorkerRequest,
        admin::RegisterWorkerResponse,
        admin::WorkerListResponse,
        admin::WorkerSummary,
        admin::HeartbeatPayload,
        crate::types::WorkerCapacity,
    )),
    tags(
        (name = "Workers", description = "Worker registration and management")
    ),
    info(
        title = "BoxLite Coordinator",
        description = "Distributed coordinator for BoxLite worker pool management",
        version = "0.7.5"
    )
)]
struct ApiDoc;

/// Build the coordinator's Axum router.
pub fn build_router(state: Arc<CoordinatorState>) -> Router {
    Router::new()
        // Swagger UI
        .merge(
            SwaggerUi::new("/swagger-ui")
                .url("/api-docs/openapi.json", ApiDoc::openapi()),
        )
        // Auth & config (handled locally)
        .route("/v1/oauth/tokens", post(proxy::oauth_token))
        .route("/v1/config", get(proxy::get_config))
        // Runtime metrics (aggregated from workers)
        .route("/v1/{namespace}/metrics", get(proxy::runtime_metrics))
        // Box CRUD (proxied to workers)
        .route(
            "/v1/{namespace}/boxes",
            post(proxy::create_box).get(proxy::list_boxes),
        )
        .route(
            "/v1/{namespace}/boxes/{box_id}",
            get(proxy::get_box)
                .delete(proxy::remove_box)
                .head(proxy::head_box),
        )
        // Box lifecycle
        .route("/v1/{namespace}/boxes/{box_id}/start", post(proxy::start_box))
        .route("/v1/{namespace}/boxes/{box_id}/stop", post(proxy::stop_box))
        // Execution
        .route(
            "/v1/{namespace}/boxes/{box_id}/exec",
            post(proxy::start_execution),
        )
        .route(
            "/v1/{namespace}/boxes/{box_id}/executions/{exec_id}",
            get(proxy::get_execution),
        )
        .route(
            "/v1/{namespace}/boxes/{box_id}/executions/{exec_id}/output",
            get(proxy::stream_output),
        )
        .route(
            "/v1/{namespace}/boxes/{box_id}/executions/{exec_id}/input",
            post(proxy::send_input),
        )
        .route(
            "/v1/{namespace}/boxes/{box_id}/executions/{exec_id}/signal",
            post(proxy::send_signal),
        )
        .route(
            "/v1/{namespace}/boxes/{box_id}/executions/{exec_id}/resize",
            post(proxy::resize_tty),
        )
        // Admin endpoints (coordinator-only)
        .route(
            "/v1/admin/workers",
            post(admin::register_worker).get(admin::list_workers),
        )
        .route(
            "/v1/admin/workers/{worker_id}",
            delete(admin::remove_worker),
        )
        .route(
            "/v1/admin/workers/{worker_id}/heartbeat",
            post(admin::worker_heartbeat),
        )
        .with_state(state)
}

/// Start the coordinator server.
pub async fn serve(host: &str, port: u16, store: SqliteStateStore) -> anyhow::Result<()> {
    let state = Arc::new(CoordinatorState {
        store: Arc::new(store) as Arc<dyn StateStore>,
        scheduler: Arc::new(LeastLoadedScheduler),
    });

    let app = build_router(state);
    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    tracing::info!("Coordinator listening on {addr}");
    eprintln!("BoxLite coordinator listening on http://{addr}");
    eprintln!("Swagger UI: http://{addr}/swagger-ui/");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("Coordinator shutting down...");
            eprintln!("\nShutting down...");
        })
        .await?;

    Ok(())
}
