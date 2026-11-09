//! Configuration discovery endpoint.

use axum::Json;

use super::super::types::{ServerCapabilities, ServerConfig};

pub(in crate::commands::serve) async fn get_config() -> Json<ServerConfig> {
    Json(ServerConfig {
        capabilities: ServerCapabilities {
            linux_capabilities_enabled: true,
            cpu_limit_enabled: cfg!(target_os = "linux"),
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

    /// The client gates per-exec `user` on this flag (#2116): a serve that
    /// supports the field must advertise it, or clients refuse to send users.
    #[tokio::test]
    async fn config_advertises_exec_user() {
        assert!(get_config().await.0.capabilities.exec_user_enabled);
    }

    #[tokio::test]
    async fn cpu_limit_capability_is_linux_only() {
        assert_eq!(
            get_config().await.0.capabilities.cpu_limit_enabled,
            cfg!(target_os = "linux")
        );
    }
}
