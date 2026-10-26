//! How the shim starts a checkpoint-enabled VM.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Checkpoint settings carried in the shim's [`InstanceSpec`](crate::vmm::InstanceSpec).
///
/// Present only for checkpoint-enabled boxes; the engine then switches the
/// libkrun context to snapshot mode before configuring any device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointLaunch {
    /// Where the shim binds the control socket (the short binding path).
    pub control_socket: PathBuf,
    /// Box-owned directory the shim writes raw exports into.
    pub export_dir: PathBuf,
    pub start: CheckpointStart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum CheckpointStart {
    /// Boot the guest from scratch.
    Cold,
    /// Restore a raw image paused, without loading a kernel or running cold
    /// guest setup. The NIC, vsock and transport endpoints are the spec's own.
    Import(ImportLaunch),
}

/// Inputs for restoring a raw image as a new VM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportLaunch {
    /// The raw VM image to restore.
    pub image: PathBuf,
    /// Box-owned directory, not yet existing, for the restored disks. Given
    /// exactly when the image has disks.
    pub disk_dir: Option<PathBuf>,
    /// Box-owned directory, not yet existing, for the restored share copies.
    /// Given exactly when the image has shares.
    pub fs_dir: Option<PathBuf>,
    /// Console log for the restored VM. Must not exist yet: the owner creates
    /// it, so a failed import never truncates an earlier log.
    pub console_output: PathBuf,
}
