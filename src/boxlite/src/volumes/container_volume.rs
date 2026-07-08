//! Container volume management.
//!
//! Manages bind mounts from guest VM paths into container namespace.
//! Works with GuestVolumeManager to set up the underlying virtiofs shares.
//!
//! Uses convention-based paths following Kata pattern:
//! - Host: Only tracks volume_name, doesn't know guest paths
//! - Guest: Constructs paths from `/run/boxlite/shared/containers/{container_id}/volumes/{volume_name}`
//! - Or host may provide an explicit guest source path for aggregate shares

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
    /// Optional explicit source path in the guest.
    pub source: Option<String>,
    /// Destination path in container
    pub destination: String,
    /// Read-only mount
    pub read_only: bool,
    /// Owner UID of host directory (for auto-idmap in guest)
    pub owner_uid: u32,
    /// Owner GID of host directory (for auto-idmap in guest)
    pub owner_gid: u32,
    /// For a single-file mount, the file name to bind-mount from the staged
    /// share dir; `None` for a whole-directory mount.
    pub subpath: Option<String>,
}

/// Manages container-level volume configuration.
///
/// Holds a reference to GuestVolumeManager and tracks bind mounts
/// from guest VM paths into container namespace.
pub struct ContainerVolumeManager<'a> {
    #[cfg_attr(target_os = "linux", allow(dead_code))]
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
    #[cfg_attr(target_os = "linux", allow(dead_code))]
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
        subpath: Option<String>,
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
            source: None,
            destination: container_path.to_string(),
            read_only,
            owner_uid,
            owner_gid,
            subpath,
        });
    }

    /// Add a container bind mount directly.
    ///
    /// Use when guest path already exists (e.g., from block device mount).
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn add_bind_volume(
        &mut self,
        volume_name: &str,
        source: Option<String>,
        container_path: &str,
        read_only: bool,
        owner_uid: u32,
        owner_gid: u32,
        subpath: Option<String>,
    ) {
        self.container_mounts.push(ContainerMount {
            volume_name: volume_name.to_string(),
            source,
            destination: container_path.to_string(),
            read_only,
            owner_uid,
            owner_gid,
            subpath,
        });
    }

    /// Build container mount configuration.
    pub fn build_container_mounts(&self) -> Vec<ContainerMount> {
        self.container_mounts.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_volume_carries_subpath_for_single_file() {
        let mut guest = GuestVolumeManager::new();
        let mut mgr = ContainerVolumeManager::new(&mut guest);
        mgr.add_volume(
            "cid",
            "uservol0",
            "uservol0",
            PathBuf::from("/host/parent"),
            "/etc/app.conf",
            true,
            0,
            0,
            Some("app.conf".to_string()),
        );

        let mounts = mgr.build_container_mounts();
        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].subpath, Some("app.conf".to_string()));
    }

    #[test]
    fn add_bind_volume_does_not_create_guest_virtiofs_share() {
        let mut guest = GuestVolumeManager::new();
        let mut mgr = ContainerVolumeManager::new(&mut guest);
        mgr.add_bind_volume(
            "uservol0",
            Some("/run/boxlite/user-volumes/uservol0".to_string()),
            "/data",
            false,
            1000,
            1000,
            Some("app.conf".to_string()),
        );

        let mounts = mgr.build_container_mounts();
        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].volume_name, "uservol0");
        assert_eq!(
            mounts[0].source.as_deref(),
            Some("/run/boxlite/user-volumes/uservol0")
        );
        assert_eq!(mounts[0].subpath, Some("app.conf".to_string()));

        drop(mgr);
        let vmm_config = guest.build_vmm_config();
        assert!(
            vmm_config.fs_shares.shares().is_empty(),
            "container mounts should not create per-volume virtiofs shares"
        );
        assert!(
            guest.build_guest_mounts().is_empty(),
            "bind-backed user volumes should not require guest virtiofs mounts"
        );
    }
}
