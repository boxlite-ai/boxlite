//! Container volume management.
//!
//! Manages bind mounts from guest VM paths into container namespace.
//! Works with GuestVolumeManager to set up the underlying virtiofs shares.
//!
//! Uses convention-based paths following Kata pattern:
//! - Host: Only tracks volume_name, doesn't know guest paths
//! - Guest: Constructs paths from `/run/boxlite/shared/containers/{container_id}/volumes/{volume_name}`

use std::path::PathBuf;

use super::guest_volume::GuestVolumeManager;

/// Container bind mount entry.
///
/// Uses convention-based paths - guest constructs full path from volume_name:
/// `/run/boxlite/shared/containers/{container_id}/volumes/{volume_name}`
#[derive(Debug, Clone)]
pub struct ContainerMount {
    /// Volume name (guest constructs full path using convention)
    pub volume_name: String,
    /// Destination path in container
    pub destination: String,
    /// Read-only mount
    pub read_only: bool,
    /// Owner UID of host directory (for auto-idmap in guest)
    pub owner_uid: u32,
    /// Owner GID of host directory (for auto-idmap in guest)
    pub owner_gid: u32,
}

/// Manages container-level volume configuration.
///
/// Holds a reference to GuestVolumeManager and tracks bind mounts
/// from guest VM paths into container namespace.
pub struct ContainerVolumeManager<'a> {
    guest: &'a mut GuestVolumeManager,
    container_mounts: Vec<ContainerMount>,
}

impl<'a> ContainerVolumeManager<'a> {
    /// Create a new container volume manager.
    pub fn new(guest: &'a mut GuestVolumeManager) -> Self {
        Self {
            guest,
            container_mounts: Vec::new(),
        }
    }

    /// Add a user volume using convention-based paths.
    ///
    /// Follows Kata pattern:
    /// - Host: Only knows volume_name and virtiofs tag
    /// - Proto: Sends volume_name + container_id to guest
    /// - Guest: Constructs full path from convention + container_id + volume_name
    /// - Container: Bind mount from guest path to user-specified container path
    ///
    /// Convention (guest-side only):
    /// `/run/boxlite/shared/containers/{container_id}/volumes/{volume_name}`
    ///
    /// # Arguments
    /// * `container_id` - Container ID for path construction
    /// * `volume_name` - Volume identifier (e.g., "data", "config")
    /// * `tag` - Virtiofs tag name (e.g., "uservol0")
    /// * `host_path` - Path on host to share
    /// * `container_path` - Mount point in container (user-specified)
    /// * `read_only` - Whether the mount is read-only
    #[allow(clippy::too_many_arguments)]
    pub fn add_volume(
        &mut self,
        container_id: &str,
        volume_name: &str,
        tag: &str,
        host_path: PathBuf,
        container_path: &str,
        read_only: bool,
        owner_uid: u32,
        owner_gid: u32,
    ) {
        // Add virtiofs share to guest with container_id
        // Guest will mount at convention path: /run/boxlite/shared/containers/{container_id}/volumes/{tag}
        self.guest.add_fs_share(
            tag,
            host_path,
            None,
            read_only,
            Some(container_id.to_string()),
        );

        // Record container bind mount - guest constructs source path from convention
        self.container_mounts.push(ContainerMount {
            volume_name: volume_name.to_string(),
            destination: container_path.to_string(),
            read_only,
            owner_uid,
            owner_gid,
        });
    }

    /// Add a container bind mount directly.
    ///
    /// Use when guest path already exists (e.g., from block device mount).
    #[allow(dead_code)]
    pub fn add_bind(&mut self, volume_name: &str, container_path: &str, read_only: bool) {
        self.container_mounts.push(ContainerMount {
            volume_name: volume_name.to_string(),
            destination: container_path.to_string(),
            read_only,
            owner_uid: 0,
            owner_gid: 0,
        });
    }

    /// Build container mount configuration.
    pub fn build_container_mounts(&self) -> Vec<ContainerMount> {
        self.container_mounts.clone()
    }
}
