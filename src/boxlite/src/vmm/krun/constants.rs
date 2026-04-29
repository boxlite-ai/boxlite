/// TSI (Transparent Socket Impersonation) feature configuration for vsock devices.
#[derive(Debug, Clone, Copy)]
pub enum TsiFeatures {
    /// No TSI hijacking — vsock IPC only, guest cannot route sockets through host.
    None,
    /// Hijack AF_INET sockets (outbound TCP/UDP forwarded through host).
    HijackInet,
    /// Hijack AF_UNIX sockets (Unix domain sockets forwarded through host).
    HijackUnix,
    /// Hijack both AF_INET and AF_UNIX sockets.
    HijackAll,
}

impl TsiFeatures {
    pub fn as_raw(self) -> u32 {
        match self {
            Self::None => 0,
            Self::HijackInet => 1 << 0,
            Self::HijackUnix => 1 << 1,
            Self::HijackAll => (1 << 0) | (1 << 1),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tsi_features_none_is_zero() {
        assert_eq!(TsiFeatures::None.as_raw(), 0);
    }

    #[test]
    fn tsi_features_hijack_inet_is_bit_0() {
        assert_eq!(TsiFeatures::HijackInet.as_raw(), 1);
    }

    #[test]
    fn tsi_features_hijack_unix_is_bit_1() {
        assert_eq!(TsiFeatures::HijackUnix.as_raw(), 2);
    }

    #[test]
    fn tsi_features_hijack_all_combines_both_bits() {
        let raw = TsiFeatures::HijackAll.as_raw();
        assert_eq!(raw, 3);
        assert_eq!(
            raw,
            TsiFeatures::HijackInet.as_raw() | TsiFeatures::HijackUnix.as_raw()
        );
    }

    #[test]
    fn tsi_features_variants_are_distinct() {
        let values: Vec<u32> = [
            TsiFeatures::None,
            TsiFeatures::HijackInet,
            TsiFeatures::HijackUnix,
            TsiFeatures::HijackAll,
        ]
        .iter()
        .map(|f| f.as_raw())
        .collect();
        for i in 0..values.len() {
            for j in (i + 1)..values.len() {
                assert_ne!(values[i], values[j], "variants {i} and {j} must differ");
            }
        }
    }
}

/// Network feature flags (host-specific)
pub mod network_features {
    // Virtio-net feature flags for libkrun net
    // These match the VIRTIO_NET_F_* features from virtio specification
    // Used when configuring external network backends like libslirp
    pub const NET_FEATURE_CSUM: u32 = 1 << 0; // Guest handles packets with partial checksum
    pub const NET_FEATURE_GUEST_CSUM: u32 = 1 << 1; // Guest handles packets with partial checksum offload
    pub const NET_FEATURE_GUEST_TSO4: u32 = 1 << 7; // Guest can receive TSOv4
    pub const NET_FEATURE_GUEST_UFO: u32 = 1 << 10; // Guest can receive UFO
    pub const NET_FEATURE_HOST_TSO4: u32 = 1 << 11; // Host can receive TSOv4
    pub const NET_FEATURE_HOST_UFO: u32 = 1 << 14; // Host can receive UFO

    // Network configuration flags for libkrun
    // NET_FLAG_VFKIT: Send the VFKIT magic ("VFKT") after establishing connection
    // This is required by gvproxy when using VFKit protocol with unixgram sockets
    pub const NET_FLAG_VFKIT: u32 = 1 << 0;
}
