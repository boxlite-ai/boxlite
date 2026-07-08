//! Integration tests for the network backend abstraction.

use std::path::PathBuf;

use boxlite::net::{NetworkBackendConfig, NetworkBackendSpec};

fn test_config(socket_path: PathBuf) -> NetworkBackendConfig {
    NetworkBackendConfig {
        port_mappings: vec![(8080, 80), (3000, 3000), (5432, 5432)],
        socket_path,
        allow_net: Vec::new(),
        secrets: Vec::new(),
        ca_dir: PathBuf::from("/tmp/test-ca"),
    }
}

#[test]
fn spec_carries_unique_socket_path_across_serde() {
    // The wire spec carries a unique per-box socket path across the serde
    // boundary to the shim (guards the old gvproxy socket collision, where the
    // Go library generated /tmp/gvproxy-{id}.sock).
    let spec = NetworkBackendSpec {
        port_mappings: vec![(8080, 80)],
        socket_path: PathBuf::from("/boxes/box-a/sockets/net.sock"),
        allow_net: Vec::new(),
        secrets: Vec::new(),
        ca_cert_pem: None,
        ca_key_pem: None,
    };

    // socket_path survives serde — this is how it crosses to the shim.
    let json = serde_json::to_string(&spec).unwrap();
    let deserialized: NetworkBackendSpec = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.socket_path, spec.socket_path);
    assert_eq!(deserialized.port_mappings, spec.port_mappings);
}

#[cfg(feature = "gvproxy")]
#[test]
fn factory_creates_backend_whose_spec_reflects_config() {
    // The abstract factory is used purely through the trait — the caller never
    // names a concrete backend. The one created backend produces the wire spec.
    use boxlite::net::{NetworkBackendFactory, default_factory};

    let factory: std::sync::Arc<dyn NetworkBackendFactory> = default_factory();
    let config = test_config(PathBuf::from("/tmp/factory-test/net.sock"));

    let backend = factory.create(&config).expect("gvproxy backend");
    let spec = backend.spec();
    // The config's socket/ports cross into the wire spec via production spec().
    assert_eq!(spec.socket_path, config.socket_path);
    assert_eq!(spec.port_mappings, config.port_mappings);
    // No secrets configured → no CA is minted.
    assert!(spec.ca_cert_pem.is_none());
}

#[cfg(not(feature = "gvproxy"))]
#[test]
fn no_backend_factory_yields_none() {
    use boxlite::net::{NetworkBackendFactory, default_factory};

    let factory: std::sync::Arc<dyn NetworkBackendFactory> = default_factory();
    let config = test_config(PathBuf::from("/tmp/factory-test/net.sock"));
    assert!(factory.create(&config).is_none());
}
