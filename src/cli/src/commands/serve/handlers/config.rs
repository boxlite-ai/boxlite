//! Configuration discovery endpoint.

use axum::Json;

use super::super::types::{ServerCapabilities, ServerConfig};

pub(in crate::commands::serve) async fn get_config() -> Json<ServerConfig> {
    Json(ServerConfig {
        capabilities: ServerCapabilities {
            linux_capabilities_enabled: true,
            // `serve` always drives an embedded local runtime, so the gvproxy
            // shaper is always there to honour a cap.
            network_rate_limit_enabled: true,
            snapshots_enabled: true,
            clone_enabled: true,
            export_enabled: true,
            import_enabled: true,
        },
    })
}

#[cfg(test)]
mod tests {
    /// The Rust client gates a capped create on this exact key
    /// (`rest::types::ServerCapabilities`); a name drift between the two
    /// `ServerCapabilities` types would make the gate refuse forever.
    #[tokio::test]
    async fn advertises_network_rate_limit_support() {
        let config = super::get_config().await.0;
        let json = serde_json::to_value(&config).expect("serialize config");
        assert_eq!(json["capabilities"]["network_rate_limit_enabled"], true);
    }
}
