//! Network statistics from gvisor-tap-vsock.
//!
//! This module provides safe access to network counters for debugging
//! connection issues and performance analysis.

use serde::{Deserialize, Serialize};

/// Network statistics from a gvproxy instance.
///
/// Design:
/// - Matches Go's NetworkStats struct exactly (DRY)
/// - Serde for JSON deserialization (Boring Code)
/// - All fields public for easy access (No premature encapsulation)
/// - Uses #[serde(rename)] to map Go's PascalCase to Rust's snake_case
///
/// # Example
///
/// ```no_run
/// # use boxlite::net::gvproxy::stats::NetworkStats;
/// let stats_json = r#"{"BytesSent":1024,"BytesReceived":2048,"TCP":{"ForwardMaxInFlightDrop":0,"CurrentEstablished":1,"FailedConnectionAttempts":0,"Retransmits":0,"Timeouts":0}}"#;
/// let stats = NetworkStats::from_json_str(stats_json)?;
/// if stats.tcp.forward_max_inflight_drop > 0 {
///     tracing::warn!(
///         drops = stats.tcp.forward_max_inflight_drop,
///         "Connections dropped due to maxInFlight limit"
///     );
/// }
/// # Ok::<(), serde_json::Error>(())
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkStats {
    /// Total bytes transmitted to the VM
    #[serde(rename = "BytesSent")]
    pub bytes_sent: u64,

    /// Total bytes received from the VM
    #[serde(rename = "BytesReceived")]
    pub bytes_received: u64,

    /// TCP-specific statistics
    #[serde(rename = "TCP")]
    pub tcp: TcpStats,
}

/// TCP layer statistics.
///
/// Design:
/// - snake_case to follow Rust conventions (Go uses PascalCase)
/// - Explicit doc comments on critical fields
/// - Uses #[serde(rename)] to map Go's PascalCase to Rust's snake_case
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TcpStats {
    /// **Critical for debugging connection slowness.**
    ///
    /// Number of SYN packets dropped because the TCP forwarder
    /// maxInFlight=10 limit was exceeded.
    ///
    /// If this counter is >0, it proves connections are being dropped
    /// due to insufficient concurrent connection slots.
    ///
    /// **Solution:** Increase maxInFlight from 10 to 1000 in tcp.go
    #[serde(rename = "ForwardMaxInFlightDrop")]
    pub forward_max_inflight_drop: u64,

    /// Current connections in ESTABLISHED state
    #[serde(rename = "CurrentEstablished")]
    pub current_established: u64,

    /// Total failed connection attempts
    #[serde(rename = "FailedConnectionAttempts")]
    pub failed_connection_attempts: u64,

    /// Total TCP segments retransmitted (performance indicator)
    #[serde(rename = "Retransmits")]
    pub retransmits: u64,

    /// Number of RTO (retransmission timeout) events
    #[serde(rename = "Timeouts")]
    pub timeouts: u64,
}

impl NetworkStats {
    /// Parses NetworkStats from JSON string.
    ///
    /// Design:
    /// - Single Responsibility: Only parsing, no FFI
    /// - Explicit Errors: Returns specific serde_json::Error
    /// - Boring Code: Direct serde deserialization
    ///
    /// Naming alternatives considered:
    /// - from_json, parse, decode, deserialize, from_json_str ✅
    pub fn from_json_str(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_network_stats() {
        let json = r#"{
            "BytesSent": 1024,
            "BytesReceived": 2048,
            "TCP": {
                "ForwardMaxInFlightDrop": 100,
                "CurrentEstablished": 5,
                "FailedConnectionAttempts": 2,
                "Retransmits": 10,
                "Timeouts": 1
            }
        }"#;

        let stats = NetworkStats::from_json_str(json).unwrap();
        assert_eq!(stats.bytes_sent, 1024);
        assert_eq!(stats.tcp.forward_max_inflight_drop, 100);
    }

    #[test]
    fn test_deserialize_invalid_json() {
        let result = NetworkStats::from_json_str("invalid");
        assert!(result.is_err());
    }

    #[test]
    fn test_stats_equality() {
        // Test uses snake_case field names (Rust side)
        // but deserialization handles PascalCase (Go/JSON side)
        let stats1 = NetworkStats {
            bytes_sent: 1024,
            bytes_received: 2048,
            tcp: TcpStats {
                forward_max_inflight_drop: 0,
                current_established: 1,
                failed_connection_attempts: 0,
                retransmits: 0,
                timeouts: 0,
            },
        };

        let stats2 = stats1.clone();
        assert_eq!(stats1, stats2);
    }
}
