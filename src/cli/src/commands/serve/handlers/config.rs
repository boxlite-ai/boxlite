//! Configuration discovery endpoint.

use axum::{Extension, Json};

use boxlite::experimental::ExperimentalFeatures;

use super::super::types::{ServerCapabilities, ServerConfig};

pub(in crate::commands::serve) async fn get_config(
    features: Option<Extension<ExperimentalFeatures>>,
) -> Json<ServerConfig> {
    Json(ServerConfig {
        capabilities: ServerCapabilities {
            checkpoints_enabled: false,
            memory_checkpoints_enabled: false,
            linux_capabilities_enabled: true,
            privileged_enabled: true,
            snapshots_enabled: true,
            clone_enabled: true,
            export_enabled: true,
            import_enabled: true,
            exec_user_enabled: true,
            volume_read_only_enabled: true,
            typed_mounts_enabled: true,
            runtime_mounts_enabled: features
                .is_some_and(|features| super::mounts::enabled(&features.0)),
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
        assert!(get_config(None).await.0.capabilities.exec_user_enabled);
    }

    #[tokio::test]
    async fn config_does_not_advertise_local_checkpoints() {
        let capabilities = get_config(None).await.0.capabilities;
        assert!(!capabilities.checkpoints_enabled);
        assert!(!capabilities.memory_checkpoints_enabled);
    }

    #[tokio::test]
    async fn config_advertises_volume_mount_support() {
        let capabilities = get_config(None).await.0.capabilities;
        assert!(capabilities.volume_read_only_enabled);
        assert!(capabilities.typed_mounts_enabled);
    }
}
