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
