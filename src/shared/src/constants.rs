//! Shared constants between host and guest
//!
//! These constants must be identical on both sides of the host-guest boundary.

use std::path::{Component, Path};

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
    /// Native virtio-fs device containing the logical share exports.
    pub const AGGREGATE: &str = "boxlite";
    /// Tag for prepared rootfs virtiofs share (merged mode)
    pub const ROOTFS: &str = "BoxLiteContainer0Rootfs";

    /// Tag for image layers directory (mounted at container's diff dir)
    pub const LAYERS: &str = "BoxLiteContainer0Layers";

    /// Tag for shared container directory (contains overlayfs/ and rootfs/)
    pub const SHARED: &str = "BoxLiteShared";
}

/// Roots of the mounts the guest runtime makes for every container before any
/// user mount applies. A directory delivered at runtime must not sit at, below
/// or above one of them: it would hide the container's own mount.
pub const STANDARD_MOUNT_TARGETS: [&str; 4] = ["/dev", "/proc", "/sys", "/tmp"];

/// The mount target as the store, the shim and the guest all spell it: an
/// absolute UTF-8 path of at least one normal component, without `..`. `.` and
/// repeated separators are dropped.
pub fn normalize_target(target: &str) -> Option<String> {
    if !target.starts_with('/') || target.contains('\0') {
        return None;
    }
    let mut components = Vec::new();
    for component in Path::new(target).components() {
        match component {
            Component::RootDir | Component::CurDir => (),
            Component::Normal(name) => components.push(name.to_str()?),
            _ => return None,
        }
    }
    (!components.is_empty()).then(|| format!("/{}", components.join("/")))
}

/// Whether `path` lies below `dir`. Components are compared, so `/devnull` is
/// not below `/dev`.
pub fn path_is_below(path: impl AsRef<Path>, dir: impl AsRef<Path>) -> bool {
    let (path, dir) = (path.as_ref(), dir.as_ref());
    path.strip_prefix(dir).is_ok() && path != dir
}

/// Whether the container paths `a` and `b` are equal, or one lies below the
/// other.
pub fn paths_overlap(a: impl AsRef<Path>, b: impl AsRef<Path>) -> bool {
    let (a, b) = (a.as_ref(), b.as_ref());
    a == b || path_is_below(a, b) || path_is_below(b, a)
}

/// The standard mount root that `target` is at, below or above, if any.
pub fn reserved_mount_target(target: impl AsRef<Path>) -> Option<&'static str> {
    let target = target.as_ref();
    STANDARD_MOUNT_TARGETS
        .into_iter()
        .find(|root| paths_overlap(target, *root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_paths_compare_by_component() {
        for (path, dir) in [("/dev/null", "/dev"), ("/tmp/work", "/tmp")] {
            assert!(path_is_below(path, dir) && paths_overlap(path, dir));
        }
        for (path, dir) in [("/devnull", "/dev"), ("/tmpwork", "/tmp")] {
            assert!(!path_is_below(path, dir) && !paths_overlap(path, dir));
        }
        // Equal paths overlap without one lying below the other.
        assert!(!path_is_below("/dev", "/dev") && paths_overlap("/dev", "/dev"));
        assert!(paths_overlap("/dev", "/dev/null"));
    }

    #[test]
    fn reserved_targets_follow_path_components() {
        for target in [
            "/dev",
            "/dev/",
            "/dev/null",
            "/proc",
            "/sys/fs",
            "/tmp",
            "/tmp/work",
        ] {
            assert!(reserved_mount_target(target).is_some(), "{target}");
        }
        assert!(reserved_mount_target("/tmpwork").is_none());
        assert_eq!(reserved_mount_target("/proc/1"), Some("/proc"));
    }

    #[test]
    fn a_target_is_normalized_or_refused() {
        assert_eq!(normalize_target("//work/./"), Some("/work".to_owned()));
        for target in ["", "/", "relative", "/a/../b", "/a\0"] {
            assert_eq!(normalize_target(target), None, "{target:?}");
        }
    }
}

/// SSH lifecycle limits shared between host and guest.
pub mod ssh {
    use std::time::Duration;

    /// Maximum wait for guest SSH cleanup before returning `DeadlineExceeded`.
    pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
}

/// File-transfer constants shared between host, guest, and runner.
pub mod files {
    /// In-flight chunk count for the bounded channel that bridges blocking
    /// archive I/O with the async stream (backpressure window ≈
    /// `COPY_CHUNK_SIZE` × this).
    pub const COPY_CHUNKS_IN_FLIGHT: usize = 4;

    /// Chunk size emitted by the stream pack side (1 MiB).
    pub const COPY_CHUNK_SIZE: usize = 1 << 20;
}
