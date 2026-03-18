//! Coordinator role — REST API gateway that dispatches to workers via gRPC.

pub mod handlers;
pub mod state;

use std::sync::Arc;

use axum::Router;
use axum::routing::{delete, get, post, put};
use utoipa::OpenApi;
use utoipa::openapi::security::{
    ClientCredentials, Flow, HttpAuthScheme, HttpBuilder, OAuth2, Scopes, SecurityScheme,
};
use utoipa_swagger_ui::SwaggerUi;

use crate::coordinator::handlers::{admin, proxy, types};
use crate::coordinator::state::CoordinatorState;
use crate::scheduler::LeastLoadedScheduler;
use crate::store::StateStore;
use crate::store::sqlite::SqliteStateStore;

#[derive(OpenApi)]
#[openapi(
    paths(
        // Authentication & Configuration
        proxy::oauth_token,
        proxy::get_config,
        // Boxes
        proxy::create_box,
        proxy::list_boxes,
        proxy::get_box,
        proxy::head_box,
        proxy::remove_box,
        proxy::start_box,
        proxy::stop_box,
        // Snapshots
        proxy::create_snapshot,
        proxy::list_snapshots,
        proxy::get_snapshot,
        proxy::remove_snapshot,
        proxy::restore_snapshot,
        // Clone / Export / Import
        proxy::clone_box,
        proxy::export_box,
        proxy::import_box,
        // Execution
        proxy::start_execution,
        proxy::exec_tty,
        proxy::get_execution,
        proxy::stream_output,
        proxy::send_input,
        proxy::send_signal,
        proxy::resize_tty,
        // Files
        proxy::upload_files,
        proxy::download_files,
        // Metrics
        proxy::runtime_metrics,
        proxy::get_box_metrics,
        // Images
        proxy::pull_image,
        proxy::list_images,
        proxy::get_image,
        proxy::image_exists,
        // Admin (coordinator-only)
        admin::register_worker,
        admin::list_workers,
        admin::remove_worker,
        admin::worker_heartbeat,
    ),
    components(schemas(
        // Configuration
        types::SandboxConfig,
        types::SandboxDefaults,
        types::SandboxCapabilities,
        // Authentication
        types::TokenRequest,
        types::TokenResponse,
        // Error
        handlers::error::ErrorResponse,
        handlers::error::ErrorModel,
        // Box
        types::RestBoxResponse,
        types::BoxStatus,
        types::CreateBoxRequest,
        types::VolumeSpec,
        types::PortSpec,
        types::SecurityPreset,
        types::ListBoxesResponse,
        types::StopBoxRequest,
        // Snapshots
        types::Snapshot,
        types::CreateSnapshotRequest,
        types::ListSnapshotsResponse,
        // Clone / Export
        types::CloneBoxRequest,
        types::ExportBoxRequest,
        // Execution
        types::RestExecRequest,
        types::RestExecResponse,
        types::ExecutionInfo,
        types::SignalRequest,
        types::ResizeRequest,
        // Metrics
        types::RuntimeMetrics,
        types::BoxMetrics,
        types::BootTiming,
        // Images
        types::ImageInfo,
        types::PullImageRequest,
        types::ListImagesResponse,
        // Admin
        admin::RegisterWorkerRequest,
        admin::RegisterWorkerResponse,
        admin::WorkerListResponse,
        admin::WorkerSummary,
        admin::HeartbeatPayload,
        crate::types::WorkerCapacity,
    )),
    tags(
        (name = "Configuration", description = "Server capability discovery"),
        (name = "Authentication", description = "OAuth2 token exchange"),
        (name = "Boxes", description = "Sandbox box lifecycle management"),
        (name = "Execution", description = "Command execution and streaming"),
        (name = "Files", description = "File upload and download"),
        (name = "Metrics", description = "Runtime and per-box metrics"),
        (name = "Images", description = "Container image management"),
        (name = "Workers", description = "Worker registration and management"),
    ),
    info(
        title = "BoxLite Cloud Sandbox REST API",
        description = "RESTful API for the BoxLite cloud sandbox service.\n\nBoxLite provides hardware-level VM isolation for secure, isolated code execution.\nThis API exposes sandbox lifecycle management, command execution, file transfer,\nand image management as a multi-tenant cloud service.",
        version = "0.1.0",
        license(name = "Apache-2.0", url = "https://www.apache.org/licenses/LICENSE-2.0"),
        contact(name = "BoxLite", url = "https://github.com/boxlite-ai/boxlite"),
    ),
    modifiers(&SecuritySchemeAddon),
)]
pub struct ApiDoc;

struct SecuritySchemeAddon;

impl utoipa::Modify for SecuritySchemeAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);

        components.add_security_scheme(
            "BearerAuth",
            SecurityScheme::Http(
                HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .bearer_format("JWT")
                    .description(Some(
                        "Bearer token obtained via OAuth2 client credentials flow",
                    ))
                    .build(),
            ),
        );

        components.add_security_scheme(
            "OAuth2",
            SecurityScheme::OAuth2(OAuth2::new([Flow::ClientCredentials(
                ClientCredentials::new(
                    "/v1/oauth/tokens",
                    Scopes::from_iter([
                        ("boxes:read", "Read box information and status"),
                        ("boxes:write", "Create, modify, and delete boxes"),
                        ("boxes:exec", "Execute commands and manage executions"),
                        ("images:read", "List and inspect cached images"),
                        ("images:write", "Pull images from registries"),
                        (
                            "runtime:admin",
                            "Runtime administration (metrics, shutdown)",
                        ),
                    ]),
                ),
            )])),
        );
    }
}

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
        .route("/v1/{prefix}/metrics", get(proxy::runtime_metrics))
        // Box CRUD (proxied to workers)
        .route(
            "/v1/{prefix}/boxes",
            post(proxy::create_box).get(proxy::list_boxes),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}",
            get(proxy::get_box)
                .delete(proxy::remove_box)
                .head(proxy::head_box),
        )
        // Box lifecycle
        .route("/v1/{prefix}/boxes/{box_id}/start", post(proxy::start_box))
        .route("/v1/{prefix}/boxes/{box_id}/stop", post(proxy::stop_box))
        // Snapshots
        .route(
            "/v1/{prefix}/boxes/{box_id}/snapshots",
            post(proxy::create_snapshot).get(proxy::list_snapshots),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}/snapshots/{snapshot_name}",
            get(proxy::get_snapshot).delete(proxy::remove_snapshot),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}/snapshots/{snapshot_name}/restore",
            post(proxy::restore_snapshot),
        )
        // Clone / Export / Import
        .route("/v1/{prefix}/boxes/{box_id}/clone", post(proxy::clone_box))
        .route("/v1/{prefix}/boxes/{box_id}/export", post(proxy::export_box))
        .route("/v1/{prefix}/boxes/import", post(proxy::import_box))
        // Execution
        .route(
            "/v1/{prefix}/boxes/{box_id}/exec",
            post(proxy::start_execution),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}/exec/tty",
            get(proxy::exec_tty),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}",
            get(proxy::get_execution),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/output",
            get(proxy::stream_output),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/input",
            post(proxy::send_input),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/signal",
            post(proxy::send_signal),
        )
        .route(
            "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/resize",
            post(proxy::resize_tty),
        )
        // Files
        .route(
            "/v1/{prefix}/boxes/{box_id}/files",
            put(proxy::upload_files).get(proxy::download_files),
        )
        // Box metrics
        .route(
            "/v1/{prefix}/boxes/{box_id}/metrics",
            get(proxy::get_box_metrics),
        )
        // Images
        .route("/v1/{prefix}/images/pull", post(proxy::pull_image))
        .route("/v1/{prefix}/images", get(proxy::list_images))
        .route(
            "/v1/{prefix}/images/{image_id}",
            get(proxy::get_image).head(proxy::image_exists),
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
