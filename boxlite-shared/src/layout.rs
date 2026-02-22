//! Filesystem layout definitions shared between host and guest.
//!
//! This module provides layout structs for the shared filesystem pattern:
//! - `SharedGuestLayout`: Layout for the shared directory (virtiofs mount)
//! - `SharedContainerLayout`: Per-container directory layout within shared/
//!
//! Lives in boxlite-shared so both host and guest can use these definitions.

use std::path::{Path, PathBuf};

// ============================================================================
// CONSTANTS
// ============================================================================

/// Shared filesystem directory names.
pub mod dirs {
    /// Host preparation directory (host writes here)
    pub const MOUNTS: &str = "mounts";

    /// Guest-visible directory (bind mount target, read-only on Linux)
    pub const SHARED: &str = "shared";

    /// Containers subdirectory
    pub const CONTAINERS: &str = "containers";

    /// Container rootfs directory name (all rootfs strategies mount here)
    pub const ROOTFS: &str = "rootfs";

    /// Overlayfs directory name (contains upper/ and work/)
    pub const OVERLAYFS: &str = "overlayfs";

    /// Overlayfs upper directory name
    pub const UPPER: &str = "upper";

    /// Overlayfs work directory name
    pub const WORK: &str = "work";

    /// Overlayfs diff directory name (contains image layers)
    pub const DIFF: &str = "diff";

    /// Layers directory name (virtiofs source for image layers)
    pub const LAYERS: &str = "layers";

    /// Volumes directory name (contains user volumes)
    pub const VOLUMES: &str = "volumes";
}

/// Guest base path (FHS-compliant).
pub const GUEST_BASE: &str = "/run/boxlite";

// ============================================================================
// SHARED CONTAINER LAYOUT (per-container directories)
// ============================================================================

/// Per-container directory layout within the shared filesystem.
///
/// Represents the directory structure for a single container:
/// ```text
/// {root}/                    # shared/containers/{cid}/
/// ├── overlayfs/
/// │   ├── diff/              # Image layers (lower dirs for overlayfs)
/// │   ├── upper/             # Overlayfs upper (writable layer)
/// │   └── work/              # Overlayfs work directory
/// ├── rootfs/                # All rootfs strategies mount here
/// └── volumes/               # User volumes (virtiofs mounts)
///     ├── {volume-name-1}/
///     └── {volume-name-2}/
/// ```
#[derive(Clone, Debug)]
pub struct SharedContainerLayout {
    root: PathBuf,
}

impl SharedContainerLayout {
    /// Create a container layout with the given root path.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Root directory of this container: shared/containers/{cid}
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Overlayfs directory: {root}/overlayfs
    pub fn overlayfs_dir(&self) -> PathBuf {
        self.root.join(dirs::OVERLAYFS)
    }

    /// Upper directory: {root}/overlayfs/upper
    ///
    /// Writable layer for overlayfs.
    pub fn upper_dir(&self) -> PathBuf {
        self.overlayfs_dir().join(dirs::UPPER)
    }

    /// Work directory: {root}/overlayfs/work
    ///
    /// Overlayfs work directory.
    pub fn work_dir(&self) -> PathBuf {
        self.overlayfs_dir().join(dirs::WORK)
    }

    /// Diff directory: {root}/overlayfs/diff
    ///
    /// Contains image layers (lower dirs for overlayfs).
    pub fn diff_dir(&self) -> PathBuf {
        self.overlayfs_dir().join(dirs::DIFF)
    }

    /// Rootfs directory: {root}/rootfs
    ///
    /// All rootfs strategies (merged, overlayfs, disk image) mount here.
    /// Guest bind mounts /run/boxlite/{cid}/rootfs/ to this location.
    pub fn rootfs_dir(&self) -> PathBuf {
        self.root.join(dirs::ROOTFS)
    }

    /// Volumes directory: {root}/volumes
    ///
    /// Base directory for user volume mounts.
    pub fn volumes_dir(&self) -> PathBuf {
        self.root.join(dirs::VOLUMES)
    }

    /// Specific volume directory: {root}/volumes/{volume_name}
    ///
    /// Convention-based path for a specific user volume.
    /// Both host and guest use this to construct volume mount paths.
    pub fn volume_dir(&self, volume_name: &str) -> PathBuf {
        self.volumes_dir().join(volume_name)
    }

    /// Layers directory: {root}/layers
    ///
    /// Source directory for image layers (virtiofs mount point).
    /// Guest bind-mounts from here to diff_dir for overlayfs.
    pub fn layers_dir(&self) -> PathBuf {
        self.root.join(dirs::LAYERS)
    }

    /// Prepare container directories.
    pub fn prepare(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(self.upper_dir())?;
        std::fs::create_dir_all(self.work_dir())?;
        std::fs::create_dir_all(self.rootfs_dir())?;
        std::fs::create_dir_all(self.volumes_dir())?;
        Ok(())
    }
}

// ============================================================================
// SHARED GUEST LAYOUT (shared directory root)
// ============================================================================

/// Shared directory layout - identical structure on host and guest.
///
/// This struct represents the directory structure under:
/// - Host: `~/.boxlite/boxes/{box-id}/mounts/`
/// - Guest: `/run/boxlite/shared/`
///
/// The structure is:
/// ```text
/// {base}/
/// └── containers/
///     └── {cid}/              # SharedContainerLayout
///         ├── overlayfs/{upper,work}
///         └── rootfs/
/// ```
///
/// # Example
///
/// ```
/// use boxlite_shared::layout::SharedGuestLayout;
///
/// // Host usage
/// let host_layout = SharedGuestLayout::new("/home/user/.boxlite/boxes/abc123/mounts");
///
/// // Guest usage
/// let guest_layout = SharedGuestLayout::new("/run/boxlite/shared");
///
/// // Both have identical container paths relative to base
/// let host_container = host_layout.container("main");
/// let guest_container = guest_layout.container("main");
/// assert!(host_container.rootfs_dir().ends_with("containers/main/rootfs"));
/// assert!(guest_container.rootfs_dir().ends_with("containers/main/rootfs"));
/// ```
#[derive(Clone, Debug)]
pub struct SharedGuestLayout {
    base: PathBuf,
}

impl SharedGuestLayout {
    /// Create a shared layout with the given base path.
    pub fn new(base: impl Into<PathBuf>) -> Self {
        Self { base: base.into() }
    }

    /// Base directory of this shared layout.
    pub fn base(&self) -> &Path {
        &self.base
    }

    /// Containers directory: {base}/containers
    pub fn containers_dir(&self) -> PathBuf {
        self.base.join(dirs::CONTAINERS)
    }

    /// Get layout for a specific container.
    pub fn container(&self, container_id: &str) -> SharedContainerLayout {
        SharedContainerLayout::new(self.containers_dir().join(container_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // ========================================================================
    // SharedContainerLayout tests
    // ========================================================================

    #[test]
    fn test_container_layout_paths() {
        let container = SharedContainerLayout::new("/test/shared/containers/main");

        assert_eq!(
            container.root().to_str().unwrap(),
            "/test/shared/containers/main"
        );
        assert_eq!(
            container.overlayfs_dir().to_str().unwrap(),
            "/test/shared/containers/main/overlayfs"
        );
        assert_eq!(
            container.upper_dir().to_str().unwrap(),
            "/test/shared/containers/main/overlayfs/upper"
        );
        assert_eq!(
            container.work_dir().to_str().unwrap(),
            "/test/shared/containers/main/overlayfs/work"
        );
        assert_eq!(
            container.rootfs_dir().to_str().unwrap(),
            "/test/shared/containers/main/rootfs"
        );
    }

    // ========================================================================
    // SharedGuestLayout tests
    // ========================================================================

    #[test]
    fn test_shared_guest_layout_paths() {
        let layout = SharedGuestLayout::new("/test/shared");

        assert_eq!(layout.base().to_str().unwrap(), "/test/shared");
        assert_eq!(
            layout.containers_dir().to_str().unwrap(),
            "/test/shared/containers"
        );
    }

    #[test]
    fn test_shared_guest_layout_container() {
        let layout = SharedGuestLayout::new("/test/shared");
        let container = layout.container("main");

        assert_eq!(
            container.overlayfs_dir().to_str().unwrap(),
            "/test/shared/containers/main/overlayfs"
        );
        assert_eq!(
            container.rootfs_dir().to_str().unwrap(),
            "/test/shared/containers/main/rootfs"
        );
    }

    #[test]
    fn test_shared_guest_layout_host_guest_identical() {
        // Host and guest have identical structure under their respective bases
        let host = SharedGuestLayout::new("/home/user/.boxlite/boxes/abc/mounts");
        let guest = SharedGuestLayout::new("/run/boxlite/shared");

        // Relative paths are identical
        let host_rootfs_dir = host.container("main").rootfs_dir();
        let guest_rootfs_dir = guest.container("main").rootfs_dir();
        let host_rel = host_rootfs_dir.strip_prefix(host.base()).unwrap();
        let guest_rel = guest_rootfs_dir.strip_prefix(guest.base()).unwrap();
        assert_eq!(host_rel, guest_rel);
    }

    // ========================================================================
    // Property-based tests
    // ========================================================================

    proptest! {
        #[test]
        fn prop_all_container_paths_under_root(
            base in "[a-z/]{1,30}",
            cid in "[a-zA-Z0-9]{1,20}"
        ) {
            let layout = SharedGuestLayout::new(&base);
            let container = layout.container(&cid);

            // Every generated path must be a child of the container root
            let root = container.root().to_path_buf();
            prop_assert!(container.overlayfs_dir().starts_with(&root));
            prop_assert!(container.upper_dir().starts_with(&root));
            prop_assert!(container.work_dir().starts_with(&root));
            prop_assert!(container.diff_dir().starts_with(&root));
            prop_assert!(container.rootfs_dir().starts_with(&root));
            prop_assert!(container.volumes_dir().starts_with(&root));
            prop_assert!(container.layers_dir().starts_with(&root));
        }

        #[test]
        fn prop_volume_dir_under_volumes(
            base in "[a-z/]{1,30}",
            cid in "[a-zA-Z0-9]{1,20}",
            vol in "[a-zA-Z0-9_-]{1,20}"
        ) {
            let layout = SharedGuestLayout::new(&base);
            let container = layout.container(&cid);
            let volume_path = container.volume_dir(&vol);
            prop_assert!(volume_path.starts_with(container.volumes_dir()));
        }

        #[test]
        fn prop_host_guest_relative_paths_identical(
            host_base in "/[a-z]{1,10}(/[a-z]{1,10}){0,3}",
            guest_base in "/[a-z]{1,10}(/[a-z]{1,10}){0,3}",
            cid in "[a-zA-Z0-9]{1,10}"
        ) {
            let host = SharedGuestLayout::new(&host_base);
            let guest = SharedGuestLayout::new(&guest_base);

            let host_rootfs = host.container(&cid).rootfs_dir();
            let guest_rootfs = guest.container(&cid).rootfs_dir();

            let host_rel = host_rootfs.strip_prefix(host.base()).unwrap();
            let guest_rel = guest_rootfs.strip_prefix(guest.base()).unwrap();
            prop_assert_eq!(host_rel, guest_rel);
        }
    }
}
