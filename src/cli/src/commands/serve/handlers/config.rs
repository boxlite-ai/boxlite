//! Configuration discovery endpoint.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;

use super::super::AppState;
use super::super::types::{ServerCapabilities, ServerConfig};

/// SDK clients send `volumes[].host_path` only when this says the server binds
/// host paths, so it follows `--host-path-root` exactly.
pub(in crate::commands::serve) async fn get_config(
    State(state): State<Arc<AppState>>,
) -> Json<ServerConfig> {
    Json(ServerConfig {
        capabilities: ServerCapabilities {
            linux_capabilities_enabled: true,
            snapshots_enabled: true,
            clone_enabled: true,
            export_enabled: true,
            import_enabled: true,
            host_path_volumes_enabled: state.host_paths.enabled(),
        },
    })
}
