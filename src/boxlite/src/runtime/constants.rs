//! Constants for BoxLite runtime
//!
//! Centralized location for all hardcoded values, paths, and configuration.
//! Host controls all paths - guest receives these via GuestInitRequest.

// Re-export shared constants from boxlite-core
pub use boxlite_shared::constants::{container, mount_tags, network};

/// Guest runtime paths known to the host.
///
/// Guest-only paths remain in the guest crate.
pub mod guest_paths {
    /// Directory containing executables bundled in the guest rootfs.
    pub const BIN_DIR: &str = "/boxlite/bin";

    /// Guest agent executable bundled in the immutable guest rootfs.
    pub const AGENT: &str = "/boxlite/bin/boxlite-guest";
}

pub mod envs {
    pub const BOXLITE_HOME: &str = "BOXLITE_HOME";

    /// REST API base URL (required for REST mode).
    #[cfg(feature = "rest")]
    pub const BOXLITE_REST_URL: &str = "BOXLITE_REST_URL";

    /// Opaque API key, sent directly as `Authorization: Bearer <key>`. Flat
    /// name (not `BOXLITE_REST_API_KEY`) matches industry convention —
    /// `STRIPE_API_KEY`, `HEROKU_API_KEY`, `GH_TOKEN`.
    #[cfg(feature = "rest")]
    pub const BOXLITE_API_KEY: &str = "BOXLITE_API_KEY";

    /// Value substituted into the `{prefix}` URL segment on
    /// box-scoped routes (`/v1/{prefix}/boxes/...`). Opaque
    /// to the client — deployment decides what it means. When
    /// unset / empty the client builds URLs without the segment
    /// (`/v1/boxes/...`) — the canonical single-tenant shape
    /// used by `boxlite serve` and similar single-scope deployments.
    #[cfg(feature = "rest")]
    pub const BOXLITE_REST_PATH_PREFIX: &str = "BOXLITE_REST_PATH_PREFIX";
}

/// Container images used by the runtime
pub mod images {
    /// Default container image when none is specified
    pub const DEFAULT: &str = "alpine:latest";
}

/// Filesystem and mount options
pub mod fs_options {
    /// Default tmpfs size for writable layer (in MB)
    pub const TMPFS_SIZE_MB: usize = 1024;

    /// Overlayfs mount options
    pub const OVERLAYFS_OPTIONS: &[&str] =
        &["metacopy=off", "redirect_dir=off", "index=off", "xino=off"];
}

/// Virtual machine resource defaults
pub mod vm_defaults {
    /// Default number of CPUs allocated to a Box
    pub const DEFAULT_CPUS: u8 = 1;

    /// Default memory in MiB allocated to a Box
    pub const DEFAULT_MEMORY_MIB: u32 = 1024;

    /// Default disk size in GB for the container rootfs (sparse, grows as needed)
    pub const DEFAULT_DISK_SIZE_GB: u64 = 10;
}

/// File naming patterns
pub mod filenames {
    /// Lock file name
    pub const LOCK_FILE: &str = ".lock";
}
