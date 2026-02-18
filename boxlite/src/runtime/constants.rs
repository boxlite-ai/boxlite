//! Constants for BoxLite runtime
//!
//! Centralized location for all hardcoded values, paths, and configuration.
//! Host controls all paths - guest receives these via GuestInitRequest.

// Re-export shared constants from boxlite-core
pub use boxlite_shared::constants::{container, mount_tags, network};

/// Guest mount points (paths inside the guest).
///
/// Note: Host only knows BIN_DIR (for guest entrypoint).
/// All other guest paths are determined by the guest based on tags.
pub mod guest_paths {
    /// Guest binary directory (for guest entrypoint executable)
    pub const BIN_DIR: &str = "/boxlite/bin";
}

pub mod envs {
    pub const BOXLITE_HOME: &str = "BOXLITE_HOME";

    /// REST API base URL (required for REST mode).
    #[cfg(feature = "rest")]
    pub const BOXLITE_REST_URL: &str = "BOXLITE_REST_URL";

    /// OAuth2 client ID (optional).
    #[cfg(feature = "rest")]
    pub const BOXLITE_REST_CLIENT_ID: &str = "BOXLITE_REST_CLIENT_ID";

    /// OAuth2 client secret (optional).
    #[cfg(feature = "rest")]
    pub const BOXLITE_REST_CLIENT_SECRET: &str = "BOXLITE_REST_CLIENT_SECRET";

    /// API path prefix (default: "v1").
    #[cfg(feature = "rest")]
    pub const BOXLITE_REST_PREFIX: &str = "BOXLITE_REST_PREFIX";
}

/// Container images used by the runtime
pub mod images {
    /// Default container image when none is specified
    pub const DEFAULT: &str = "alpine:latest";

    /// Base image for VM init rootfs (must include mkfs.ext4 for disk formatting)
    pub const INIT_ROOTFS: &str = "debian:bookworm-slim";
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
    pub const DEFAULT_MEMORY_MIB: u32 = 2048;

    /// Default disk size in GB for the container rootfs (sparse, grows as needed)
    pub const DEFAULT_DISK_SIZE_GB: u64 = 10;
}

/// File naming patterns
pub mod filenames {
    use crate::runtime::layout::dirs;
    use std::path::{Path, PathBuf};

    /// Lock file name
    pub const LOCK_FILE: &str = ".lock";

    pub fn box_home(home_dir: &Path, box_id: &str) -> PathBuf {
        home_dir.join(dirs::BOXES_DIR).join(box_id)
    }

    /// Get full path for Unix socket
    pub fn unix_socket_path(home_dir: &Path, box_id: &str) -> PathBuf {
        box_home(home_dir, box_id)
            .join(dirs::SOCKETS_DIR)
            .join("box.sock")
    }
}
