//! Configuration discovery endpoint.

use axum::Json;

use super::super::types::{ServerCapabilities, ServerConfig};

pub(in crate::commands::serve) async fn get_config() -> Json<ServerConfig> {
    Json(ServerConfig {
        capabilities: ServerCapabilities {
            linux_capabilities_enabled: true,
            privileged_enabled: true,
            snapshots_enabled: true,
            memory_snapshots_enabled: false,
            clone_enabled: true,
            export_enabled: true,
            import_enabled: true,
            exec_user_enabled: true,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The client gates per-exec `user` on this flag (#2116): a serve that
    /// supports the field must advertise it, or clients refuse to send users.
    #[tokio::test]
    async fn config_advertises_exec_user() {
        assert!(get_config().await.0.capabilities.exec_user_enabled);
    }
}
