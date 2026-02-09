//! Gvproxy configuration structures

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Local DNS zone configuration
///
/// Defines local DNS records served by the gateway's embedded DNS server.
/// Queries not matching any zone are forwarded to the host's system DNS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsZone {
    /// Zone name (e.g., "myapp.local.", "." for root)
    pub name: String,
    /// Default IP for unmatched queries in this zone
    pub default_ip: String,
}

/// Port mapping configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortMapping {
    /// Host port to bind
    pub host_port: u16,
    /// Guest port to forward to
    pub guest_port: u16,
}

/// Network configuration for gvproxy instance
///
/// This structure encapsulates all configuration needed to create a gvproxy
/// virtual network, replacing the previous approach of hardcoding values in Go.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GvproxyConfig {
    /// Unix socket path for the network tap interface.
    /// Caller-provided to ensure each box gets a unique, collision-free path.
    pub socket_path: PathBuf,

    /// Virtual network subnet (e.g., "192.168.127.0/24")
    pub subnet: String,

    /// Gateway IP address (gvproxy's IP)
    pub gateway_ip: String,

    /// Gateway MAC address
    pub gateway_mac: String,

    /// Guest IP address
    pub guest_ip: String,

    /// Guest MAC address
    pub guest_mac: String,

    /// MTU for the virtual network
    pub mtu: u16,

    /// Port mappings: (host_port, guest_port)
    pub port_mappings: Vec<PortMapping>,

    /// Local DNS zones for the gateway's embedded DNS server
    pub dns_zones: Vec<DnsZone>,

    /// DNS search domains
    pub dns_search_domains: Vec<String>,

    /// Enable debug logging in gvproxy
    pub debug: bool,

    /// Optional pcap file path for packet capture (for debugging)
    /// Records all network traffic to a file readable by Wireshark
    /// Set via config or BOXLITE_NET_CAPTURE_FILE environment variable
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_file: Option<String>,
}

/// Create a config with network defaults for the given socket path.
fn defaults_with_socket_path(socket_path: PathBuf) -> GvproxyConfig {
    use crate::net::constants::*;

    GvproxyConfig {
        socket_path,
        subnet: SUBNET.to_string(),
        gateway_ip: GATEWAY_IP.to_string(),
        gateway_mac: GATEWAY_MAC_STRING.to_string(),
        guest_ip: GUEST_IP.to_string(),
        guest_mac: GUEST_MAC_STRING.to_string(),
        mtu: DEFAULT_MTU,
        port_mappings: Vec::new(),
        dns_zones: Vec::new(),
        dns_search_domains: DNS_SEARCH_DOMAINS.iter().map(|s| s.to_string()).collect(),
        debug: false,
        capture_file: None,
    }
}

impl GvproxyConfig {
    /// Create a new configuration with the given socket path and port mappings
    ///
    /// Uses default values for all other network settings.
    ///
    /// # Arguments
    ///
    /// * `socket_path` - Caller-provided Unix socket path (must be unique per box)
    /// * `port_mappings` - List of (host_port, guest_port) tuples
    pub fn new(socket_path: PathBuf, port_mappings: Vec<(u16, u16)>) -> Self {
        let mut config = Self {
            port_mappings: port_mappings
                .into_iter()
                .map(|(host_port, guest_port)| PortMapping {
                    host_port,
                    guest_port,
                })
                .collect(),
            ..defaults_with_socket_path(socket_path)
        };

        // Check environment variable for capture file
        if let Ok(capture_file) = std::env::var("BOXLITE_NET_CAPTURE_FILE")
            && !capture_file.is_empty()
        {
            tracing::info!(
                capture_file,
                "Enabling packet capture from BOXLITE_NET_CAPTURE_FILE"
            );
            config.capture_file = Some(capture_file);
        }

        // Enable debug mode when capturing
        if config.capture_file.is_some() {
            config.debug = true;
            tracing::info!("Enabling gvproxy debug mode for packet capture");
        }

        config
    }

    /// Enable debug logging
    pub fn with_debug(mut self, debug: bool) -> Self {
        self.debug = debug;
        self
    }

    /// Set custom DNS zones
    pub fn with_dns_zones(mut self, dns_zones: Vec<DnsZone>) -> Self {
        self.dns_zones = dns_zones;
        self
    }

    /// Set custom MTU
    pub fn with_mtu(mut self, mtu: u16) -> Self {
        self.mtu = mtu;
        self
    }

    /// Enable packet capture to pcap file
    ///
    /// Records all network traffic to a file that can be analyzed with Wireshark.
    /// This is a debugging feature and should not be enabled in production.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::net::gvproxy::GvproxyConfig;
    ///
    /// let config = GvproxyConfig::new(vec![(8080, 80)])
    ///     .with_capture_file("/tmp/network.pcap".to_string());
    /// ```
    pub fn with_capture_file(mut self, capture_file: String) -> Self {
        self.capture_file = Some(capture_file);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_socket_path() -> PathBuf {
        PathBuf::from("/tmp/test-gvproxy.sock")
    }

    #[test]
    fn test_new_config_defaults() {
        let config = GvproxyConfig::new(test_socket_path(), vec![]);
        assert_eq!(config.socket_path, test_socket_path());
        assert_eq!(config.subnet, "192.168.127.0/24");
        assert_eq!(config.gateway_ip, "192.168.127.1");
        assert_eq!(config.guest_ip, "192.168.127.2");
        assert_eq!(config.mtu, 1500);
        assert!(!config.debug);
        assert!(config.dns_zones.is_empty());
    }

    #[test]
    fn test_new_with_port_mappings() {
        let config = GvproxyConfig::new(test_socket_path(), vec![(8080, 80), (8443, 443)]);
        assert_eq!(config.port_mappings.len(), 2);
        assert_eq!(config.port_mappings[0].host_port, 8080);
        assert_eq!(config.port_mappings[0].guest_port, 80);
    }

    #[test]
    fn test_builder_pattern() {
        let config = GvproxyConfig::new(test_socket_path(), vec![(8080, 80)])
            .with_debug(true)
            .with_mtu(9000);

        assert!(config.debug);
        assert_eq!(config.mtu, 9000);
    }

    #[test]
    fn test_serialization() {
        let config = GvproxyConfig::new(test_socket_path(), vec![(8080, 80)]);
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: GvproxyConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config.subnet, deserialized.subnet);
        assert_eq!(config.socket_path, deserialized.socket_path);
        assert_eq!(config.port_mappings.len(), deserialized.port_mappings.len());
    }

    #[test]
    fn test_capture_file_builder() {
        let config = GvproxyConfig::new(test_socket_path(), vec![(8080, 80)])
            .with_capture_file("/tmp/test.pcap".to_string());

        assert_eq!(config.capture_file, Some("/tmp/test.pcap".to_string()));
    }

    #[test]
    fn test_capture_file_serialization() {
        // Without capture file - should not include field in JSON
        let config = GvproxyConfig::new(test_socket_path(), vec![(8080, 80)]);
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("capture_file"));

        // With capture file - should include field in JSON
        let config_with_capture = config.with_capture_file("/tmp/test.pcap".to_string());
        let json_with_capture = serde_json::to_string(&config_with_capture).unwrap();
        assert!(json_with_capture.contains("capture_file"));
        assert!(json_with_capture.contains("/tmp/test.pcap"));

        // Deserialize and verify
        let deserialized: GvproxyConfig = serde_json::from_str(&json_with_capture).unwrap();
        assert_eq!(
            deserialized.capture_file,
            Some("/tmp/test.pcap".to_string())
        );
    }

    #[test]
    fn test_new_config_no_capture_by_default() {
        let config = GvproxyConfig::new(test_socket_path(), vec![]);
        assert_eq!(config.capture_file, None);
    }

    #[test]
    fn test_socket_path_survives_json_serialization() {
        // Regression test: socket_path must appear in the JSON sent to Go's gvproxy_create.
        // If this field is missing, Go would fall back to generating /tmp/gvproxy-{id}.sock,
        // which was the root cause of the socket collision bug.

        let socket_path = PathBuf::from("/home/user/.boxlite/boxes/my-box/sockets/net.sock");
        let config = GvproxyConfig::new(socket_path.clone(), vec![(8080, 80)]);

        let json = serde_json::to_string(&config).unwrap();

        // CRITICAL: JSON must contain the socket_path field
        assert!(
            json.contains("socket_path"),
            "JSON must include socket_path field"
        );
        assert!(
            json.contains("/home/user/.boxlite/boxes/my-box/sockets/net.sock"),
            "JSON must contain the actual socket path value"
        );

        // Verify round-trip
        let deserialized: GvproxyConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.socket_path, socket_path);
    }

    #[test]
    fn test_two_configs_have_different_socket_paths_in_json() {
        // Regression test: two concurrent boxes creating gvproxy configs.
        // OLD CODE: Both would serialize to identical JSON (no socket_path field),
        //           and Go would generate /tmp/gvproxy-1.sock for both → collision.
        // NEW CODE: Each config carries its own unique socket_path.

        let config_a = GvproxyConfig::new(
            PathBuf::from("/boxes/box-a/sockets/net.sock"),
            vec![(8080, 80)],
        );
        let config_b = GvproxyConfig::new(
            PathBuf::from("/boxes/box-b/sockets/net.sock"),
            vec![(8080, 80)],
        );

        let json_a = serde_json::to_string(&config_a).unwrap();
        let json_b = serde_json::to_string(&config_b).unwrap();

        // CRITICAL: Same port mappings but different socket paths → different JSON
        assert_ne!(
            json_a, json_b,
            "Two configs with different socket paths must produce different JSON"
        );
        assert_ne!(config_a.socket_path, config_b.socket_path);
    }
}
