//! Network configuration constants shared across BoxLite components
//!
//! These constants define the virtual network topology and must
//! remain consistent across the host runtime and network backend.

/// Virtual network subnet configuration
pub const SUBNET: &str = "192.168.127.0/24";

/// Gateway IP address (gvproxy listens here)
/// Also serves as DNS server for guest containers
pub const GATEWAY_IP: &str = "192.168.127.1";

/// Guest IP address (assigned via DHCP static lease)
pub const GUEST_IP: &str = "192.168.127.2";

/// Guest IP with subnet prefix (for static IP assignment in guest)
pub const GUEST_CIDR: &str = "192.168.127.2/24";

/// Guest network interface name (created by virtio-net)
pub const GUEST_INTERFACE: &str = "eth0";

/// Gateway MAC address
///
/// This MAC is used by gvproxy's virtual network interface.
/// Uses locally administered address space (bit 2 of first octet set).
pub const GATEWAY_MAC: [u8; 6] = [0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd];

/// Guest MAC address
///
/// This MAC must match the MAC address configured by the engine for the guest's network interface.
/// Used for DHCP static lease to ensure the guest always receives GUEST_IP.
/// Last byte differs from GATEWAY_MAC by 1 (0xdd vs 0xee).
pub const GUEST_MAC: [u8; 6] = [0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xee];

/// Guest MAC address as colon-separated string (for DHCP configuration)
pub const GUEST_MAC_STRING: &str = "5a:94:ef:e4:0c:ee";

/// Gateway MAC address as colon-separated string
pub const GATEWAY_MAC_STRING: &str = "5a:94:ef:e4:0c:dd";

/// Default MTU for the virtual network
pub const DEFAULT_MTU: u16 = 1500;

/// DNS server IP address (same as gateway)
/// Containers point to this IP for DNS resolution
pub const DNS_SERVER_IP: &str = GATEWAY_IP;

/// DNS search domains
pub const DNS_SEARCH_DOMAINS: &[&str] = &["local"];

/// Helper function to format MAC address as string
pub fn mac_to_string(mac: &[u8; 6]) -> String {
    format!(
        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mac_to_string() {
        assert_eq!(mac_to_string(&GUEST_MAC), GUEST_MAC_STRING);
        assert_eq!(mac_to_string(&GATEWAY_MAC), GATEWAY_MAC_STRING);
    }

    #[test]
    fn test_mac_addresses_differ_by_one_byte() {
        // Ensure only the last byte differs
        for i in 0..5 {
            assert_eq!(GUEST_MAC[i], GATEWAY_MAC[i]);
        }
        assert_eq!(GUEST_MAC[5], 0xee);
        assert_eq!(GATEWAY_MAC[5], 0xdd);
    }
}
