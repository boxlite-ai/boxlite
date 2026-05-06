//! Virtiofs / 9p mount helper.
//!
//! Tries virtiofs first (Unix-hosted VMs), then falls back to 9p
//! (Windows-hosted VMs with WHPX). The guest binary is the same on all
//! hosts, so it auto-detects the available filesystem type at runtime.

use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::mount::{mount, MsFlags};

pub struct VirtiofsMount;

impl VirtiofsMount {
    /// Mount a shared filesystem tag to mount point.
    ///
    /// Tries virtiofs first, then falls back to 9p (virtio transport).
    pub fn mount(tag: &str, mount_point: &Path, read_only: bool) -> BoxliteResult<()> {
        tracing::info!(
            "Mounting shared fs: {} -> {} ({})",
            tag,
            mount_point.display(),
            if read_only { "ro" } else { "rw" }
        );

        // Create mount point
        std::fs::create_dir_all(mount_point).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create mount point {}: {}",
                mount_point.display(),
                e
            ))
        })?;

        let mut flags = MsFlags::empty();
        if read_only {
            flags |= MsFlags::MS_RDONLY;
        }

        // Try virtiofs first (Hypervisor.framework / KVM hosts)
        match mount(
            Some(tag),
            mount_point,
            Some("virtiofs"),
            flags,
            None::<&str>,
        ) {
            Ok(()) => {
                tracing::info!("Mounted virtiofs: {} -> {}", tag, mount_point.display());
                return Ok(());
            }
            Err(e) => {
                tracing::debug!("virtiofs mount failed ({}), trying 9p...", e);
            }
        }

        // Fallback to 9p (WHPX hosts)
        mount(
            Some(tag),
            mount_point,
            Some("9p"),
            flags,
            Some("trans=virtio,version=9p2000.L"),
        )
        .map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to mount {} at {} (tried virtiofs and 9p): {}",
                tag,
                mount_point.display(),
                e
            ))
        })?;

        tracing::info!("Mounted 9p: {} -> {}", tag, mount_point.display());
        Ok(())
    }
}
