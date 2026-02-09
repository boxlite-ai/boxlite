//! Integration tests for network backend selection and configuration.

use std::path::PathBuf;

use boxlite::net::{NetworkBackendConfig, NetworkBackendFactory};

fn test_socket_path() -> PathBuf {
    PathBuf::from("/tmp/test-network-backend.sock")
}

#[test]
#[cfg(all(not(feature = "libslirp-backend"), not(feature = "gvproxy-backend")))]
fn test_no_backend_when_no_features_enabled() {
    // When no backend features are enabled, factory should return None
    let config = NetworkBackendConfig::new(vec![], test_socket_path());
    let backend = NetworkBackendFactory::create(config).unwrap();

    assert!(
        backend.is_none(),
        "Expected None when no backend features are enabled"
    );
}

// Note: libslirp backend tests are disabled because the backend's endpoint()
// implementation is incomplete and returns an error. These tests can be
// re-enabled once the backend is fully implemented.

#[test]
fn test_network_config_creation() {
    // Test NetworkConfig constructor
    let port_mappings = vec![(8080, 80), (3000, 3000), (5432, 5432)];
    let config = NetworkBackendConfig::new(port_mappings.clone(), test_socket_path());

    assert_eq!(config.port_mappings.len(), 3);
    assert_eq!(config.port_mappings, port_mappings);
    assert_eq!(config.socket_path, test_socket_path());
}

#[tokio::test]
#[cfg(any(feature = "libslirp-backend", feature = "gvproxy-backend"))]
async fn test_backend_trait_send_sync() {
    use boxlite::net::NetworkBackend;

    // Verify NetworkBackend trait objects are Send + Sync
    fn assert_send_sync<T: Send + Sync>() {}

    let config = NetworkBackendConfig::new(vec![], test_socket_path());
    let backend = NetworkBackendFactory::create(config).unwrap();

    // This will fail to compile if NetworkBackend is not Send + Sync
    fn check_send_sync(backend: Box<dyn NetworkBackend>) {
        assert_send_sync::<Box<dyn NetworkBackend>>();
        drop(backend);
    }

    if let Some(backend) = backend {
        check_send_sync(backend);
    }
}

// Note: libslirp backend tests are disabled because the backend's endpoint()
// implementation is incomplete and returns an error.

#[test]
fn test_network_config_carries_unique_socket_paths() {
    // Regression test for gvproxy socket path collision bug.
    // Verifies that NetworkBackendConfig (the caller-facing config)
    // carries the socket path through serialization — this is how the path
    // crosses the process boundary from main process → shim subprocess.
    //
    // OLD CODE: NetworkBackendConfig had no socket_path field.
    //           The Go library generated /tmp/gvproxy-{id}.sock internally,
    //           causing collisions between concurrent boxes.
    // NEW CODE: Each config carries its own unique socket_path.

    let config_a = NetworkBackendConfig::new(
        vec![(8080, 80)],
        PathBuf::from("/boxes/box-a/sockets/net.sock"),
    );
    let config_b = NetworkBackendConfig::new(
        vec![(8080, 80)],
        PathBuf::from("/boxes/box-b/sockets/net.sock"),
    );

    // Different boxes → different socket paths in config
    assert_ne!(config_a.socket_path, config_b.socket_path);

    // Verify socket_path survives serde (this is how it crosses process boundary to shim)
    let json = serde_json::to_string(&config_a).unwrap();
    let deserialized: NetworkBackendConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.socket_path, config_a.socket_path);
}
