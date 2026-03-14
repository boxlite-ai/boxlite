//! Configuration discovery endpoint.

use axum::Json;

use super::super::types::{SandboxCapabilities, SandboxConfigResponse};

pub(in crate::commands::serve) async fn get_config() -> Json<SandboxConfigResponse> {
    Json(SandboxConfigResponse {
        capabilities: SandboxCapabilities {
            snapshots_enabled: true,
            clone_enabled: true,
            export_enabled: true,
            import_enabled: true,
        },
    })
}
