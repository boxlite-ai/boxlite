//! Configuration discovery endpoint.

use std::sync::Arc;

use axum::{Json, extract::State};

use super::super::AppState;
use super::super::types::{ServerCapabilities, ServerConfig};

pub(in crate::commands::serve) async fn get_config(
    State(state): State<Arc<AppState>>,
) -> Json<ServerConfig> {
    Json(ServerConfig {
        capabilities: ServerCapabilities {
            linux_capabilities_enabled: true,
            nested_virtualization_enabled: state.nested_virtualization_enabled,
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
        let state = Arc::new(super::super::super::tests::lifecycle_state());
        assert!(
            get_config(State(state))
                .await
                .0
                .capabilities
                .exec_user_enabled
        );
    }
}
