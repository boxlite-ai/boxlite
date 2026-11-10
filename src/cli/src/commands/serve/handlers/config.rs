//! Configuration discovery endpoint.

use axum::Json;

use super::super::types::{ServerCapabilities, ServerConfig};

pub(in crate::commands::serve) async fn get_config() -> Json<ServerConfig> {
    Json(ServerConfig {
        api_version: env!("CARGO_PKG_VERSION"),
        capabilities: ServerCapabilities {
            linux_capabilities_enabled: true,
            privileged_enabled: true,
            snapshots_enabled: true,
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

    /// Legacy consumers still read flags; new clients use the product release.
    #[tokio::test]
    async fn config_advertises_exec_user() {
        let config = get_config().await.0;
        assert_eq!(config.api_version, env!("CARGO_PKG_VERSION"));
        assert!(config.capabilities.exec_user_enabled);
    }
}
