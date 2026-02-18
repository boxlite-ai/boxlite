use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::layout::{SharedGuestLayout, dirs as shared_dirs};
use std::path::{Path, PathBuf};

/// Directory structure constants
pub mod dirs {
    /// Base directory name for BoxLite data
    pub const BOXLITE_DIR: &str = ".boxlite";

    pub const DB_DIR: &str = "db";

    /// Subdirectory for images layers
    pub const IMAGES_DIR: &str = "images";

    /// Subdirectory for individual layer storage
    pub const LAYERS_DIR: &str = "layers";

    /// Subdirectory for images manifests
    pub const MANIFESTS_DIR: &str = "manifests";

    /// Subdirectory for running boxes
    pub const BOXES_DIR: &str = "boxes";

    /// Subdirectory for Unix domain sockets
    pub const SOCKETS_DIR: &str = "sockets";

    /// Subdirectory for overlayfs upper layer (Linux only)
    pub const UPPER_DIR: &str = "upper";

    /// Subdirectory for overlayfs work directory (Linux only)
    pub const WORK_DIR: &str = "work";

    /// Subdirectory for overlayfs (per container)
    pub const OVERLAYFS_DIR: &str = "overlayfs";

    /// Subdirectory for log files
    pub const LOGS_DIR: &str = "logs";

    /// Subdirectory for disk images
    pub const DISKS_DIR: &str = "disks";

    /// Subdirectory for per-entity locks
    pub const LOCKS_DIR: &str = "locks";
}

/// Configuration for filesystem layout behavior.
///
/// Controls platform-specific filesystem features like bind mounts.
#[derive(Clone, Debug, Default)]
pub struct FsLayoutConfig {
    /// Whether bind mount is supported on this platform.
    ///
    /// - `true`: Use bind mount (mounts/ → shared/), expose shared/ to guest
    /// - `false`: Skip bind mount, expose mounts/ directly to guest
    bind_mount_supported: bool,
}

impl FsLayoutConfig {
    /// Create a new config with bind mount support enabled.
    pub fn with_bind_mount() -> Self {
        Self {
            bind_mount_supported: true,
        }
    }

    /// Create a new config with bind mount support disabled.
    pub fn without_bind_mount() -> Self {
        Self {
            bind_mount_supported: false,
        }
    }

    /// Check if bind mount is supported.
    pub fn is_bind_mount_supported(&self) -> bool {
        self.bind_mount_supported
    }
}

// ============================================================================
// FILESYSTEM LAYOUT (home directory)
// ============================================================================

#[derive(Clone, Debug)]
pub struct FilesystemLayout {
    home_dir: PathBuf,
    config: FsLayoutConfig,
}

impl FilesystemLayout {
    pub fn new(home_dir: PathBuf, config: FsLayoutConfig) -> Self {
        Self { home_dir, config }
    }

    pub fn home_dir(&self) -> &Path {
        &self.home_dir
    }

    pub fn db_dir(&self) -> PathBuf {
        self.home_dir.join(dirs::DB_DIR)
    }

    pub fn images_dir(&self) -> PathBuf {
        self.home_dir.join(dirs::IMAGES_DIR)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.home_dir.join(dirs::LOGS_DIR)
    }

    /// OCI images layers storage: ~/.boxlite/images/layers
    pub fn image_layers_dir(&self) -> PathBuf {
        self.images_dir().join(dirs::LAYERS_DIR)
    }

    /// OCI images manifests cache: ~/.boxlite/images/manifests
    pub fn image_manifests_dir(&self) -> PathBuf {
        self.images_dir().join(dirs::MANIFESTS_DIR)
    }

    /// Root directory for all box workspaces: ~/.boxlite/boxes
    /// Each box gets a subdirectory containing upper/work dirs for overlayfs
    pub fn boxes_dir(&self) -> PathBuf {
        self.home_dir.join(dirs::BOXES_DIR)
    }

    /// Per-entity locks directory: ~/.boxlite/locks
    ///
    /// Contains lock files managed by FileLockManager for multiprocess-safe
    /// locking of individual entities (boxes, volumes, etc.).
    pub fn locks_dir(&self) -> PathBuf {
        self.home_dir.join(dirs::LOCKS_DIR)
    }

    /// Temporary directory for transient files: ~/.boxlite/tmp
    /// Used for disk image creation and other operations that need
    /// temp files on the same filesystem as the final destination.
    pub fn temp_dir(&self) -> PathBuf {
        self.home_dir.join("tmp")
    }

    /// Versioned guest rootfs cache directory: ~/.boxlite/rootfs
    ///
    /// Contains guest rootfs disks (image + injected boxlite-guest binary),
    /// versioned by image digest and guest binary hash.
    pub fn guest_rootfs_dir(&self) -> PathBuf {
        self.home_dir.join("rootfs")
    }

    /// Initialize the filesystem structure.
    ///
    /// Creates necessary directories (home_dir, sockets, images, etc.).
    pub fn prepare(&self) -> BoxliteResult<()> {
        std::fs::create_dir_all(&self.home_dir)
            .map_err(|e| BoxliteError::Storage(format!("failed to create home: {e}")))?;

        std::fs::create_dir_all(self.boxes_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create boxes dir: {e}")))?;

        std::fs::create_dir_all(self.temp_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create temp dir: {e}")))?;

        std::fs::create_dir_all(self.guest_rootfs_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create rootfs dir: {e}")))?;

        std::fs::create_dir_all(self.image_layers_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create layers dir: {e}")))?;

        std::fs::create_dir_all(self.image_manifests_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create manifests dir: {e}")))?;

        std::fs::create_dir_all(self.image_layout().disk_images_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create disk-images dir: {e}")))?;

        self.validate_same_filesystem()?;

        Ok(())
    }

    /// Validate that temp, rootfs, and disk-images directories are on the same filesystem.
    ///
    /// This is required for atomic `rename(2)` in staged install operations.
    /// Refuse to start if directories span multiple filesystems.
    fn validate_same_filesystem(&self) -> BoxliteResult<()> {
        use std::os::unix::fs::MetadataExt;

        let temp_dev = std::fs::metadata(self.temp_dir())
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to stat temp dir {}: {}",
                    self.temp_dir().display(),
                    e
                ))
            })?
            .dev();

        let rootfs_dev = std::fs::metadata(self.guest_rootfs_dir())
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to stat rootfs dir {}: {}",
                    self.guest_rootfs_dir().display(),
                    e
                ))
            })?
            .dev();

        let images_dev = std::fs::metadata(self.image_layout().disk_images_dir())
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to stat disk-images dir {}: {}",
                    self.image_layout().disk_images_dir().display(),
                    e
                ))
            })?
            .dev();

        if temp_dev != rootfs_dev || temp_dev != images_dev {
            return Err(BoxliteError::Storage(format!(
                "tmp, rootfs, and disk-images directories must be on the same filesystem \
                 for atomic rename. Found devices: tmp={}, rootfs={}, disk-images={}. \
                 Check your BOXLITE_HOME configuration.",
                temp_dev, rootfs_dev, images_dev
            )));
        }

        Ok(())
    }

    /// Create a box layout for a specific box ID.
    pub fn box_layout(
        &self,
        box_id: &str,
        isolate_mounts: bool,
    ) -> BoxliteResult<BoxFilesystemLayout> {
        let effective_isolate = isolate_mounts && self.config.is_bind_mount_supported();

        if isolate_mounts && !effective_isolate {
            tracing::warn!(
                "Mount isolation requested but bind mounts are not supported on this system. \
                 Falling back to shared directory without isolation."
            );
        }

        Ok(BoxFilesystemLayout::new(
            self.boxes_dir().join(box_id),
            self.config.clone(),
            effective_isolate,
        ))
    }

    /// Create an image layout for the images directory.
    pub fn image_layout(&self) -> ImageFilesystemLayout {
        ImageFilesystemLayout::new(self.images_dir())
    }
}

// ============================================================================
// BOX FILESYSTEM LAYOUT (per-box directory)
// ============================================================================

/// Filesystem layout for a single box directory.
///
/// Each box has its own directory containing:
/// - sockets/: Unix sockets for communication
/// - mounts/: Host preparation area (writable by host)
/// - shared/: Guest-visible directory (bind mount or symlink to mounts/)
/// - disk.qcow2: Virtual disk for the box
///
/// The mounts/ and shared/ directories follow this pattern:
/// - Host writes to mounts/containers/{cid}/...
/// - Guest sees shared/containers/{cid}/... via virtio-fs
/// - On Linux: shared/ is a read-only bind mount of mounts/
/// - On macOS: shared/ is a symlink to mounts/ (workaround)
///
/// # Directory Structure
///
/// ```text
/// ~/.boxlite/boxes/{box_id}/
/// ├── sockets/
/// │   ├── box.sock        # gRPC communication
/// │   └── ready.sock      # Ready notification
/// ├── mounts/             # Host preparation (SharedGuestLayout)
/// │   └── containers/
/// │       └── {cid}/
/// │           ├── image/      # Container image (lowerdir)
/// │           ├── oberlayfs/
/// │           │   ├── upper/  # Overlayfs upper
/// │           │   └── work/   # Overlayfs work
/// │           └── rootfs/     # Final rootfs (overlayfs merged)
/// ├── shared/             # Guest-visible (ro bind mount → mounts/)
/// ├── logs/               # Per-box logging
/// │   ├── boxlite-shim.log  # Shim tracing output
/// │   └── console.log       # Kernel/init output
/// ├── root.qcow2          # Data disk
/// └── guest-rootfs.qcow2  # Guest rootfs COW overlay
/// ```
#[derive(Clone, Debug)]
pub struct BoxFilesystemLayout {
    box_dir: PathBuf,
    /// SharedGuestLayout for the mounts/ directory (host writes here).
    shared_layout: SharedGuestLayout,
    /// Filesystem layout configuration.
    config: FsLayoutConfig,
    /// Whether to use bind mount isolation for the mounts directory.
    /// Only effective when bind mounts are supported on the system.
    isolate_mounts: bool,
}

impl BoxFilesystemLayout {
    pub fn new(box_dir: PathBuf, config: FsLayoutConfig, isolate_mounts: bool) -> Self {
        let shared_layout = SharedGuestLayout::new(box_dir.join(shared_dirs::MOUNTS));
        Self {
            box_dir,
            shared_layout,
            config,
            isolate_mounts,
        }
    }

    /// Root directory for this box: ~/.boxlite/boxes/{box_id}
    pub fn root(&self) -> &Path {
        &self.box_dir
    }

    // ========================================================================
    // SOCKETS
    // ========================================================================

    /// Sockets directory: ~/.boxlite/boxes/{box_id}/sockets
    pub fn sockets_dir(&self) -> PathBuf {
        self.box_dir.join(dirs::SOCKETS_DIR)
    }

    /// Unix socket path: ~/.boxlite/boxes/{box_id}/sockets/box.sock
    pub fn socket_path(&self) -> PathBuf {
        self.sockets_dir().join("box.sock")
    }

    /// Ready notification socket: ~/.boxlite/boxes/{box_id}/sockets/ready.sock
    ///
    /// Guest connects to this socket to signal it's ready to serve.
    pub fn ready_socket_path(&self) -> PathBuf {
        self.sockets_dir().join("ready.sock")
    }

    /// Network backend socket: ~/.boxlite/boxes/{box_id}/sockets/net.sock
    ///
    /// Used by the network backend (e.g., gvisor-tap-vsock) to provide
    /// virtio-net connectivity to the guest VM. Each box gets its own
    /// socket to prevent collisions between concurrent instances.
    pub fn net_backend_socket_path(&self) -> PathBuf {
        self.sockets_dir().join("net.sock")
    }

    // ========================================================================
    // MOUNTS AND SHARED
    // ========================================================================

    /// SharedGuestLayout for the mounts/ directory (host-side paths).
    ///
    /// Host preparation area. Host writes container images and rw layers here.
    /// Returns the SharedGuestLayout for accessing container directories.
    pub fn shared_layout(&self) -> &SharedGuestLayout {
        &self.shared_layout
    }

    /// Directory for host-side file preparation, exposed to guest via virtio-fs.
    ///
    /// The bind mount pattern (mounts/ → shared/) serves two purposes:
    /// 1. Host writes to mounts/ with full read-write access
    /// 2. Guest sees shared/ as read-only (bind mount with MS_RDONLY)
    ///
    /// This prevents guest from modifying host-prepared files while allowing
    /// the host to update content at any time.
    ///
    /// Returns the appropriate directory based on bind mount configuration:
    /// - `is_bind_mount_supported && isolate_mounts = true`: Returns mounts/ (host writes here, bind-mounted to shared/)
    /// - Otherwise: Returns shared/ directly (no bind mount available or not requested)
    pub fn mounts_dir(&self) -> PathBuf {
        if self.config.is_bind_mount_supported() && self.isolate_mounts {
            self.shared_layout.base().to_path_buf()
        } else {
            self.shared_dir()
        }
    }

    /// Shared directory: ~/.boxlite/boxes/{box_id}/shared
    ///
    /// Guest-visible directory. On Linux, this is a read-only bind mount of mounts/.
    /// On macOS, this is a symlink to mounts/ (workaround).
    ///
    /// This directory is exposed to the guest via virtio-fs with tag "shared".
    pub fn shared_dir(&self) -> PathBuf {
        self.box_dir.join(shared_dirs::SHARED)
    }

    // ========================================================================
    // SNAPSHOTS
    // ========================================================================

    /// Snapshots directory: ~/.boxlite/boxes/{box_id}/snapshots
    pub fn snapshots_dir(&self) -> PathBuf {
        self.box_dir
            .join(crate::disk::constants::dirs::SNAPSHOTS_DIR)
    }

    /// Named snapshot directory: ~/.boxlite/boxes/{box_id}/snapshots/{name}
    pub fn snapshot_dir(&self, name: &str) -> PathBuf {
        self.snapshots_dir().join(name)
    // BIN AND LOGS (jailer isolation)
    // ========================================================================

    /// Bin directory: ~/.boxlite/boxes/{box_id}/bin
    ///
    /// Contains the shim binary and bundled libraries, copied (or reflinked)
    /// by the jailer for memory isolation between boxes.
    pub fn bin_dir(&self) -> PathBuf {
        self.box_dir.join("bin")
    }

    /// Per-box logs directory: ~/.boxlite/boxes/{box_id}/logs
    ///
    /// Shim writes its logs here instead of the shared home_dir/logs/,
    /// so the sandbox doesn't need access to any home_dir paths for writing.
    pub fn logs_dir(&self) -> PathBuf {
        self.box_dir.join("logs")
    }

    // ========================================================================
    // DISK AND CONSOLE
    // ========================================================================

    /// Virtual disk path: ~/.boxlite/boxes/{box_id}/disk.qcow2
    pub fn disk_path(&self) -> PathBuf {
        self.box_dir
            .join(crate::disk::constants::filenames::CONTAINER_DISK)
    }

    /// Guest rootfs disk path: ~/.boxlite/boxes/{box_id}/guest-rootfs.qcow2
    pub fn guest_rootfs_disk_path(&self) -> PathBuf {
        self.box_dir
            .join(crate::disk::constants::filenames::GUEST_ROOTFS_DISK)
    }

    /// Console output path: ~/.boxlite/boxes/{box_id}/logs/console.log
    ///
    /// Captures kernel and init output for debugging.
    /// Lives inside `logs/` so the sandbox grants it via the `logs/` [RW subpath].
    pub fn console_output_path(&self) -> PathBuf {
        self.logs_dir().join("console.log")
    }

    /// Guest rootfs COW overlay: ~/.boxlite/boxes/{box_id}/guest-rootfs.qcow2
    ///
    /// A qcow2 COW overlay that references a base rootfs (either reflinked
    /// locally or in the shared `~/.boxlite/rootfs/` directory).
    pub fn guest_rootfs_disk_path(&self) -> PathBuf {
        self.box_dir.join("guest-rootfs.qcow2")
    }

    /// Reflinked rootfs base: ~/.boxlite/boxes/{box_id}/rootfs-base
    ///
    /// When the filesystem supports reflink (APFS, btrfs, xfs), the base
    /// rootfs is cloned here so the sandbox doesn't need access to
    /// `~/.boxlite/rootfs/`. On ext4 (no reflink), this file won't exist
    /// and the qcow2 overlay references the shared rootfs directly.
    pub fn rootfs_base_path(&self) -> PathBuf {
        self.box_dir.join("rootfs-base")
    }

    /// PID file path: ~/.boxlite/boxes/{box_id}/shim.pid
    ///
    /// Written by the shim process in pre_exec (after fork, before exec).
    /// This is the single source of truth for the shim process PID.
    /// Database PID is a cache that can be reconstructed from this file.
    pub fn pid_file_path(&self) -> PathBuf {
        self.box_dir.join("shim.pid")
    }

    /// Exit file path: ~/.boxlite/boxes/{box_id}/exit
    ///
    /// Written by the shim process on exit (normal or panic).
    /// Format: First line is exit code, subsequent lines contain error details.
    /// Follows Podman's conmon pattern for capturing exit information.
    pub fn exit_file_path(&self) -> PathBuf {
        self.box_dir.join("exit")
    }

    /// Stderr file path: ~/.boxlite/boxes/{box_id}/shim.stderr
    ///
    /// Captures libkrun stderr output for crash diagnostics.
    /// The signal handler reads this and includes content in exit file.
    pub fn stderr_file_path(&self) -> PathBuf {
        self.box_dir.join("shim.stderr")
    }

    // ========================================================================
    // PREPARATION AND CLEANUP
    // ========================================================================

    /// Prepare the box directory structure.
    ///
    /// Creates:
    /// - sockets/
    /// - mounts/ (via SharedGuestLayout base)
    ///
    /// Note: shared/ is NOT created here - it will be created as a bind mount
    /// (Linux) or symlink (macOS) in the filesystem stage.
    pub fn prepare(&self) -> BoxliteResult<()> {
        std::fs::create_dir_all(&self.box_dir)
            .map_err(|e| BoxliteError::Storage(format!("failed to create box dir: {e}")))?;

        std::fs::create_dir_all(self.sockets_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create sockets dir: {e}")))?;

        std::fs::create_dir_all(self.mounts_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create mounts dir: {e}")))?;

        // shared/ is created by create_bind_mount() - don't create it here
        // On Linux: bind mount from mounts/
        // On macOS: symlink to mounts/

        Ok(())
    }

    /// Cleanup the box directory.
    pub fn cleanup(&self) -> BoxliteResult<()> {
        if self.box_dir.exists() {
            std::fs::remove_dir_all(&self.box_dir)
                .map_err(|e| BoxliteError::Storage(format!("failed to cleanup box dir: {e}")))?;
        }
        Ok(())
    }
}

// ============================================================================
// IMAGE FILESYSTEM LAYOUT (images directory)
// ============================================================================

/// Filesystem layout for OCI images storage.
///
/// Contains:
/// - layers/: Downloaded layer tarballs
/// - extracted/: Extracted layer directories
/// - disk-images/: Cached disk images for COW
/// - manifests/: Image manifests
/// - configs/: Image configs
#[derive(Clone, Debug)]
pub struct ImageFilesystemLayout {
    images_dir: PathBuf,
}

impl ImageFilesystemLayout {
    pub fn new(images_dir: PathBuf) -> Self {
        Self { images_dir }
    }

    /// Local bundle cache directory: `~/.boxlite/images/local/{path_hash}-{manifest_short}`
    ///
    /// Computes isolated cache dir for a local OCI bundle. Each bundle gets a unique
    /// namespace based on both its path AND manifest digest, ensuring cache invalidation
    /// when bundle content changes.
    ///
    /// # Arguments
    /// * `bundle_path` - Path to the OCI bundle directory
    /// * `manifest_digest` - Manifest digest (e.g., "sha256:abc123...")
    pub fn local_bundle_cache_dir(&self, bundle_path: &Path, manifest_digest: &str) -> PathBuf {
        use sha2::{Digest, Sha256};

        // Hash the bundle path for location identity
        let path_str = bundle_path.to_string_lossy();
        let path_hash = Sha256::digest(path_str.as_bytes());
        let path_short = format!("{:x}", path_hash)
            .chars()
            .take(8)
            .collect::<String>();

        // Extract short manifest digest for content identity
        let manifest_short = manifest_digest
            .strip_prefix("sha256:")
            .unwrap_or(manifest_digest);
        let manifest_short = &manifest_short[..8.min(manifest_short.len())];

        self.images_dir
            .join("local")
            .join(format!("{}-{}", path_short, manifest_short))
    }

    /// Root directory: ~/.boxlite/images
    pub fn root(&self) -> &Path {
        &self.images_dir
    }

    /// Layers directory: ~/.boxlite/images/layers
    pub fn layers_dir(&self) -> PathBuf {
        self.images_dir.join(dirs::LAYERS_DIR)
    }

    /// Extracted layers directory: ~/.boxlite/images/extracted
    pub fn extracted_dir(&self) -> PathBuf {
        self.images_dir.join("extracted")
    }

    /// Disk images directory: ~/.boxlite/images/disk-images
    pub fn disk_images_dir(&self) -> PathBuf {
        self.images_dir.join("disk-images")
    }

    /// Manifests directory: ~/.boxlite/images/manifests
    pub fn manifests_dir(&self) -> PathBuf {
        self.images_dir.join(dirs::MANIFESTS_DIR)
    }

    /// Configs directory: ~/.boxlite/images/configs
    pub fn configs_dir(&self) -> PathBuf {
        self.images_dir.join("configs")
    }

    /// Prepare the images directory structure.
    pub fn prepare(&self) -> BoxliteResult<()> {
        std::fs::create_dir_all(self.layers_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create layers dir: {e}")))?;

        std::fs::create_dir_all(self.extracted_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create extracted dir: {e}")))?;

        std::fs::create_dir_all(self.disk_images_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create disk-images dir: {e}")))?;

        std::fs::create_dir_all(self.manifests_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create manifests dir: {e}")))?;

        std::fs::create_dir_all(self.configs_dir())
            .map_err(|e| BoxliteError::Storage(format!("failed to create configs dir: {e}")))?;

        Ok(())
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_bundle_cache_dir_format() {
        let layout = ImageFilesystemLayout::new(PathBuf::from("/images"));

        let cache_dir =
            layout.local_bundle_cache_dir(Path::new("/my/bundle"), "sha256:abc123def456789");

        // Should be under /images/local/
        assert!(cache_dir.starts_with("/images/local/"));

        // Format: {path_hash}-{manifest_short}
        let dir_name = cache_dir.file_name().unwrap().to_str().unwrap();
        assert!(
            dir_name.contains('-'),
            "should have format path_hash-manifest_short"
        );

        // Path hash is 8 chars, manifest short is 8 chars
        let parts: Vec<&str> = dir_name.split('-').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), 8, "path hash should be 8 chars");
        assert_eq!(parts[1].len(), 8, "manifest short should be 8 chars");
    }

    #[test]
    fn test_local_bundle_cache_invalidation_on_content_change() {
        // This test verifies that when bundle content changes (same path,
        // different manifest), a NEW cache directory is used.
        let layout = ImageFilesystemLayout::new(PathBuf::from("/images"));
        let bundle_path = Path::new("/my/bundle");

        // Original bundle version (realistic hex digest)
        let cache_v1 = layout.local_bundle_cache_dir(
            bundle_path,
            "sha256:a1b2c3d4e5f6789012345678901234567890abcd",
        );

        // Bundle content changed - new manifest digest
        let cache_v2 = layout.local_bundle_cache_dir(
            bundle_path,
            "sha256:f9e8d7c6b5a4321098765432109876543210fedc",
        );

        // CRITICAL: Different manifest = different cache dir
        // This ensures stale cache is never used after content change
        assert_ne!(
            cache_v1, cache_v2,
            "Same path but different manifest should use DIFFERENT cache dirs"
        );

        // Both should be under the same parent (local/)
        assert_eq!(cache_v1.parent(), cache_v2.parent());

        // Verify the cache dir names differ in the manifest portion
        let name_v1 = cache_v1.file_name().unwrap().to_str().unwrap();
        let name_v2 = cache_v2.file_name().unwrap().to_str().unwrap();

        // Same path hash (first part), different manifest (second part)
        let parts_v1: Vec<&str> = name_v1.split('-').collect();
        let parts_v2: Vec<&str> = name_v2.split('-').collect();

        assert_eq!(
            parts_v1[0], parts_v2[0],
            "Same path should have same path hash"
        );
        assert_ne!(
            parts_v1[1], parts_v2[1],
            "Different manifest should have different hash"
        );
    }

    #[test]
    fn test_local_bundle_cache_same_content_same_cache() {
        // Verify idempotency: same inputs = same cache dir
        let layout = ImageFilesystemLayout::new(PathBuf::from("/images"));

        let cache1 = layout.local_bundle_cache_dir(Path::new("/my/bundle"), "sha256:abc123");
        let cache2 = layout.local_bundle_cache_dir(Path::new("/my/bundle"), "sha256:abc123");

        assert_eq!(
            cache1, cache2,
            "Same path + manifest should give same cache dir"
        );
    }

    #[test]
    fn test_local_bundle_different_paths_different_caches() {
        // Different bundle paths should have different caches even with same manifest
        let layout = ImageFilesystemLayout::new(PathBuf::from("/images"));
        let manifest = "sha256:same_manifest";

        let cache1 = layout.local_bundle_cache_dir(Path::new("/bundle1"), manifest);
        let cache2 = layout.local_bundle_cache_dir(Path::new("/bundle2"), manifest);

        assert_ne!(
            cache1, cache2,
            "Different paths should have different cache dirs"
        );
    }

    #[test]
    fn test_different_boxes_get_different_net_backend_socket_paths() {
        // Regression test for gvproxy socket collision bug.
        // OLD CODE: Socket paths were generated inside Go as /tmp/gvproxy-{id}.sock
        //           with id starting at 1 per process — two shim processes would both
        //           create /tmp/gvproxy-1.sock, causing a collision.
        // NEW CODE: Each box gets its own socket path from the layout.

        let config = FsLayoutConfig::without_bind_mount();
        let box_a = BoxFilesystemLayout::new(
            PathBuf::from("/home/user/.boxlite/boxes/box-aaa"),
            config.clone(),
            false,
        );
        let box_b = BoxFilesystemLayout::new(
            PathBuf::from("/home/user/.boxlite/boxes/box-bbb"),
            config,
            false,
        );

        let path_a = box_a.net_backend_socket_path();
        let path_b = box_b.net_backend_socket_path();

        // CRITICAL: Different boxes MUST have different socket paths
        // This was the root cause of the collision bug
        assert_ne!(
            path_a, path_b,
            "Two different boxes must have different net backend socket paths"
        );

        // Verify paths are under their respective box directories
        assert!(path_a.starts_with("/home/user/.boxlite/boxes/box-aaa/sockets/"));
        assert!(path_b.starts_with("/home/user/.boxlite/boxes/box-bbb/sockets/"));

        // Verify the socket filename
        assert_eq!(path_a.file_name().unwrap(), "net.sock");
        assert_eq!(path_b.file_name().unwrap(), "net.sock");
    }

    #[test]
    fn test_guest_rootfs_dir() {
        let layout = FilesystemLayout::new(
            PathBuf::from("/home/user/.boxlite"),
            FsLayoutConfig::without_bind_mount(),
        );
        assert_eq!(
            layout.guest_rootfs_dir(),
            PathBuf::from("/home/user/.boxlite/rootfs")
        );
    }

    #[test]
    fn test_prepare_creates_guest_rootfs_dir() {
        let dir = tempfile::TempDir::new().unwrap();
        let layout = FilesystemLayout::new(
            dir.path().to_path_buf(),
            FsLayoutConfig::without_bind_mount(),
        );
        layout.prepare().unwrap();

        assert!(layout.guest_rootfs_dir().exists());
        assert!(layout.temp_dir().exists());
        assert!(layout.boxes_dir().exists());
    }

    #[test]
    fn test_prepare_validates_same_filesystem() {
        let dir = tempfile::TempDir::new().unwrap();
        let layout = FilesystemLayout::new(
            dir.path().to_path_buf(),
            FsLayoutConfig::without_bind_mount(),
        );
        // All dirs under same temp dir → same filesystem → should pass
        layout.prepare().unwrap();

        // Verify the validation passes independently
        layout.validate_same_filesystem().unwrap();
    }

    // ========================================================================
    // BoxFilesystemLayout — jailer path method tests
    // ========================================================================

    fn test_box_layout(box_dir: &str) -> BoxFilesystemLayout {
        BoxFilesystemLayout::new(
            PathBuf::from(box_dir),
            FsLayoutConfig::without_bind_mount(),
            false,
        )
    }

    #[test]
    fn test_box_layout_logs_dir() {
        let layout = test_box_layout("/home/.boxlite/boxes/mybox");
        assert_eq!(
            layout.logs_dir(),
            PathBuf::from("/home/.boxlite/boxes/mybox/logs")
        );
    }

    #[test]
    fn test_box_layout_bin_dir() {
        let layout = test_box_layout("/home/.boxlite/boxes/mybox");
        assert_eq!(
            layout.bin_dir(),
            PathBuf::from("/home/.boxlite/boxes/mybox/bin")
        );
    }

    #[test]
    fn test_box_layout_guest_rootfs_disk_path() {
        let layout = test_box_layout("/home/.boxlite/boxes/mybox");
        assert_eq!(
            layout.guest_rootfs_disk_path(),
            PathBuf::from("/home/.boxlite/boxes/mybox/guest-rootfs.qcow2")
        );
    }

    #[test]
    fn test_box_layout_rootfs_base_path() {
        let layout = test_box_layout("/home/.boxlite/boxes/mybox");
        assert_eq!(
            layout.rootfs_base_path(),
            PathBuf::from("/home/.boxlite/boxes/mybox/rootfs-base")
        );
    }

    /// All jailer-relevant paths must be rooted under box_dir.
    /// This is the core guarantee: the sandbox never grants access outside the box.
    #[test]
    fn test_box_layout_all_jailer_paths_inside_box_dir() {
        let box_dir = "/home/.boxlite/boxes/test";
        let layout = test_box_layout(box_dir);

        let paths = [
            layout.logs_dir(),
            layout.bin_dir(),
            layout.sockets_dir(),
            layout.guest_rootfs_disk_path(),
            layout.rootfs_base_path(),
            layout.exit_file_path(),
            layout.console_output_path(),
            layout.disk_path(),
        ];

        for path in &paths {
            assert!(
                path.starts_with(box_dir),
                "Path {} should be inside box_dir {}",
                path.display(),
                box_dir
            );
        }
    }
}
