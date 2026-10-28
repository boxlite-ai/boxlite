//! Configuration discovery endpoint.

use axum::Json;

use super::super::types::{ServerCapabilities, ServerConfig};

pub(in crate::commands::serve) async fn get_config() -> Json<ServerConfig> {
    Json(ServerConfig {
        capabilities: ServerCapabilities {
            cache_volumes_enabled: false,
            checkpoints_enabled: cfg!(all(target_os = "linux", target_arch = "x86_64")),
            linux_capabilities_enabled: true,
            privileged_enabled: true,
            snapshots_enabled: true,
            clone_enabled: true,
            export_enabled: true,
            import_enabled: true,
        },
    })
}
