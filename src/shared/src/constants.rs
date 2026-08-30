//! Shared constants between host and guest
//!
//! These constants must be identical on both sides of the host-guest boundary.

/// Container runtime constants
pub mod container {
    /// Default container hostname
    pub const DEFAULT_HOSTNAME: &str = "boxlite";

    /// Default RLIMIT_NOFILE soft limit
    pub const RLIMIT_NOFILE_SOFT: u64 = 1024;

    /// Default RLIMIT_NOFILE hard limit
    pub const RLIMIT_NOFILE_HARD: u64 = 1024;
}

/// Network constants
pub mod network {
    /// Default vsock port for guest agent gRPC server
    /// Port 2695 = "BOXL" on phone keypad
    pub const GUEST_AGENT_PORT: u32 = 2695;

    /// Vsock port for guest ready notification
    /// Guest connects to this port to signal it's ready to serve
    /// Port 2696 = "BOXM" on phone keypad
    pub const GUEST_READY_PORT: u32 = 2696;
}

/// Executor environment variable
///
/// Used to specify which executor to use for command execution.
pub mod executor {
    /// Environment variable name for executor selection
    pub const ENV_VAR: &str = "BOXLITE_EXECUTOR";

    /// Value for guest executor (run directly on guest)
    pub const GUEST: &str = "guest";

    /// Key for container executor (format: "container")
    pub const CONTAINER_KEY: &str = "container";
}

/// Virtiofs mount tags
///
/// These tags identify shared filesystems mounted via virtiofs.
/// They must match between host (when creating shares) and guest (when mounting).
pub mod mount_tags {
    /// Tag for prepared rootfs virtiofs share (merged mode)
    pub const ROOTFS: &str = "BoxLiteContainer0Rootfs";

    /// Tag for image layers directory (mounted at container's diff dir)
    pub const LAYERS: &str = "BoxLiteContainer0Layers";

    /// Tag for shared container directory (contains overlayfs/ and rootfs/)
    pub const SHARED: &str = "BoxLiteShared";
}

/// File-transfer constants shared between host, guest, and runner.
pub mod files {
    /// Upper bound for the size-capped *fallback* path used when a peer is too
    /// old to stream end-to-end. Transfers that must be buffered to disk/memory
    /// (because the peer omits the `source_is_dir` shape hint) are rejected past
    /// this size instead of buffering unboundedly. Matches the guest's legacy
    /// `MAX_UPLOAD_BYTES`.
    pub const FALLBACK_CAP_BYTES: u64 = 512 * 1024 * 1024;

    /// In-flight chunk count for the bounded channel that bridges blocking tar
    /// I/O with the async stream (backpressure window ≈ `PIPE_CHUNK_SIZE` ×
    /// this).
    pub const PIPE_CHUNKS: usize = 4;

    /// Chunk size emitted by the stream pack side (1 MiB).
    pub const PIPE_CHUNK_SIZE: usize = 1 << 20;
}
