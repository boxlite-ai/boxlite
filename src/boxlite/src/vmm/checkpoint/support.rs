//! Which boxes can be checkpoint-enabled.
//!
//! Every refusal happens before a VM exists and names the setting to change.
//! Nothing here weakens isolation to make a configuration fit.

use crate::runtime::constants::vm_defaults::DEFAULT_CPUS;
use crate::runtime::options::BoxOptions;
use crate::vmm::checkpoint::CheckpointStart;
use crate::vmm::{InstanceSpec, VmmKind};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

/// The mode actually selected for a start, persisted for reconnect/health.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub(crate) enum StartMode {
    Owner { protocol: u32 },
    Ordinary { checkpoint_restriction: String },
    LegacyOwner,
}

impl StartMode {
    pub fn owns_vm(&self) -> bool {
        matches!(self, Self::Owner { .. } | Self::LegacyOwner)
    }
}

pub(crate) fn select(options: &BoxOptions, host: Host) -> StartMode {
    match eligibility(options, host) {
        Ok(()) => StartMode::Owner { protocol: 2 },
        Err(error) => StartMode::Ordinary {
            checkpoint_restriction: error.to_string(),
        },
    }
}

fn eligibility(options: &BoxOptions, host: Host) -> BoxliteResult<()> {
    check_host(host)?;
    if !options.advanced.security.jailer_enabled {
        return Err(unsupported("default jailer is disabled"));
    }
    if options.advanced.nested_virtualization {
        return Err(unsupported("nested virtualization is enabled"));
    }
    check_restorable(options)?;
    check_vcpus(options.cpus.unwrap_or(DEFAULT_CPUS))?;
    if options.volumes.len() + options.mounts.len() + 2 > MAX_SHARES {
        return Err(unsupported("too many filesystem shares"));
    }
    Ok(())
}

/// Most vCPUs the snapshot owner restores.
const MAX_VCPUS: u8 = 128;

/// Most virtio-fs shares the snapshot owner restores, the guest root
/// (`/dev/root`) included.
const MAX_SHARES: usize = 7;

/// Most block devices plus NIC the snapshot owner places on the MMIO bus.
const MAX_DISKS_AND_NIC: usize = 8;

/// The host a box would launch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Host {
    pub os: &'static str,
    pub arch: &'static str,
}

impl Host {
    pub fn current() -> Self {
        Self {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }
}

fn unsupported(reason: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Unsupported(format!(
        "checkpoint restriction: {reason}. Checkpoints need Linux x86_64 with KVM, the \
         libkrun engine and the default jailed isolation"
    ))
}

/// Refuse a host where checkpoints cannot run.
pub fn check_host(host: Host) -> BoxliteResult<()> {
    if (host.os, host.arch) != ("linux", "x86_64") {
        return Err(unsupported(format_args!(
            "this host is {} {}",
            host.os, host.arch
        )));
    }
    Ok(())
}

/// Refuse what a checkpoint could not carry to a new box, before the box
/// ever runs.
fn check_restorable(options: &BoxOptions) -> BoxliteResult<()> {
    let advanced = &options.advanced;
    if !options.mounts.is_empty() {
        return Err(unsupported(
            "typed mounts are not supported by checkpoint restoration",
        ));
    }
    // A custom kernel's staged boot assets live outside the VM image.
    if advanced.kernel.is_some() {
        return Err(unsupported("a custom kernel is not supported"));
    }
    // The bind mount over `shared/` would hide the restored copy.
    if advanced.isolate_mounts {
        return Err(unsupported("advanced.isolate_mounts is not supported"));
    }
    // Secret substitution trusts a CA made for this box; a restored guest
    // would still trust the source box's.
    if !options.secrets.is_empty() {
        return Err(unsupported("secrets are not supported"));
    }
    // A single-file volume is staged inside `shared/`, so its copy would
    // alias the box's own tree.
    if let Some(volume) = options.volumes.iter().find(|volume| {
        volume.managed_volume.is_none()
            && std::fs::metadata(&volume.host_path).is_ok_and(|meta| meta.is_file())
    }) {
        return Err(unsupported(format_args!(
            "volume {} is a single file; only directory volumes are supported",
            volume.host_path
        )));
    }
    Ok(())
}

/// Refuse a launch the snapshot owner would reject, before spawning the shim.
/// A no-op for a spec without checkpoint settings.
pub fn validate_spec(spec: &InstanceSpec) -> BoxliteResult<()> {
    let Some(checkpoint) = &spec.checkpoint else {
        return Ok(());
    };
    if spec.engine != VmmKind::Libkrun {
        return Err(unsupported(format_args!("engine {:?}", spec.engine)));
    }
    if !spec.security.jailer_enabled {
        return Err(unsupported(
            "advanced.security.jailer_enabled=false is not supported",
        ));
    }
    if spec.nested_virtualization {
        return Err(unsupported("nested virtualization is not supported"));
    }
    check_vcpus(spec.cpus.unwrap_or(DEFAULT_CPUS))?;
    // Without a gvproxy NIC libkrun falls back to TSI, whose host sockets
    // live outside the guest and cannot be captured.
    let nic = spec.network_backend_spec.is_some();
    if !nic && !spec.disable_network {
        return Err(unsupported(
            "TSI networking cannot be checkpointed; use the gvproxy network or network.mode=\"disabled\"",
        ));
    }
    // A cold boot also gets the guest root, which the engine always adds; an
    // import's shares come from its image.
    let root = matches!(checkpoint.start, CheckpointStart::Cold);
    let shares = spec.fs_shares.shares().len();
    if shares + usize::from(root) > MAX_SHARES {
        return Err(unsupported(format_args!(
            "{shares} filesystem shares{} (at most {MAX_SHARES} in all)",
            if root { " plus the guest root" } else { "" }
        )));
    }
    let disks = spec.block_devices.devices().len();
    let disk_limit = MAX_DISKS_AND_NIC - usize::from(nic);
    if disks > disk_limit {
        return Err(unsupported(format_args!(
            "{disks} disks (at most {disk_limit})"
        )));
    }
    if spec.console_output.is_none() {
        return Err(unsupported("a console output file is required"));
    }
    Ok(())
}

fn check_vcpus(cpus: u8) -> BoxliteResult<()> {
    if cpus == 0 || cpus > MAX_VCPUS {
        return Err(unsupported(format_args!("{cpus} vCPUs (1 to {MAX_VCPUS})")));
    }
    Ok(())
}
