//! Which boxes can be checkpoint-enabled.
//!
//! Every refusal happens before a VM exists and names the setting to change.
//! Nothing here weakens isolation to make a configuration fit.

use crate::runtime::constants::vm_defaults::DEFAULT_CPUS;
use crate::runtime::options::BoxOptions;
use crate::vmm::checkpoint::CheckpointStart;
use crate::vmm::{InstanceSpec, VmmKind};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

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
        "advanced.checkpoint_enabled: {reason}. Checkpoints need Linux x86_64 with KVM, the \
         libkrun engine and the default jailed isolation"
    ))
}

/// Refuse checkpoint options this host and configuration cannot honor.
/// A no-op unless `advanced.checkpoint_enabled` is set.
pub fn validate_options(options: &BoxOptions, host: Host) -> BoxliteResult<()> {
    let advanced = &options.advanced;
    if !advanced.checkpoint_enabled {
        return Ok(());
    }
    check_host(host)?;
    if !advanced.security.jailer_enabled {
        return Err(unsupported(
            "advanced.security.jailer_enabled=false is not supported",
        ));
    }
    if advanced.nested_virtualization {
        return Err(unsupported("nested virtualization is not supported"));
    }
    check_restorable(options)?;
    check_vcpus(options.cpus.unwrap_or(DEFAULT_CPUS))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rootfs::guest::{GuestRootfs, Strategy};
    use crate::vmm::checkpoint::{CheckpointLaunch, CheckpointStart};
    use crate::vmm::{BlockDevice, BlockDevices, DiskFormat, Entrypoint, FsShares};
    use boxlite_shared::BoxTransport;
    use std::path::PathBuf;

    const LINUX_X86: Host = Host {
        os: "linux",
        arch: "x86_64",
    };

    fn checkpoint_options() -> BoxOptions {
        let mut options = BoxOptions::default();
        options.advanced.checkpoint_enabled = true;
        options
    }

    fn reason(result: BoxliteResult<()>) -> String {
        match result {
            Err(BoxliteError::Unsupported(reason)) => reason,
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    fn spec() -> InstanceSpec {
        InstanceSpec {
            engine: VmmKind::Libkrun,
            box_id: "box".into(),
            security: Default::default(),
            nested_virtualization: false,
            cpus: Some(2),
            memory_mib: Some(512),
            kernel: None,
            fs_shares: FsShares::new(),
            block_devices: BlockDevices::new(),
            guest_entrypoint: Entrypoint {
                executable: "/boxlite/bin/boxlite-guest".into(),
                args: Vec::new(),
                env: Vec::new(),
            },
            transport: BoxTransport::unix(PathBuf::from("/tmp/box.sock")),
            ready_transport: BoxTransport::unix(PathBuf::from("/tmp/ready.sock")),
            guest_rootfs: GuestRootfs {
                path: PathBuf::from("/rootfs"),
                strategy: Strategy::Direct,
                kernel: None,
                initrd: None,
                env: Vec::new(),
            },
            network_backend_spec: None,
            network_backend_endpoint: None,
            disable_network: true,
            home_dir: PathBuf::from("/home"),
            console_output: Some(PathBuf::from("/box/logs/console.log")),
            exit_file: PathBuf::from("/box/exit"),
            detach: false,
            checkpoint: Some(CheckpointLaunch {
                control_socket: PathBuf::from("/tmp/ctl.sock"),
                export_dir: PathBuf::from("/box/checkpoint"),
                start: CheckpointStart::Cold,
            }),
        }
    }

    fn disk(i: usize) -> BlockDevice {
        BlockDevice {
            block_id: format!("vd{i}"),
            disk_path: PathBuf::from(format!("/box/disk{i}.qcow2")),
            read_only: false,
            format: DiskFormat::Qcow2,
        }
    }

    #[test]
    fn checkpoint_option_is_off_by_default_persists_when_set_and_is_omitted_when_off() {
        let options = BoxOptions::default();
        assert!(!options.advanced.checkpoint_enabled);
        let json = serde_json::to_value(&options.advanced).unwrap();
        assert!(json.get("checkpoint_enabled").is_none(), "{json}");
        // Older persisted rows have no key at all.
        let old: crate::runtime::advanced_options::AdvancedBoxOptions =
            serde_json::from_str("{}").unwrap();
        assert!(!old.checkpoint_enabled);

        let options = checkpoint_options();
        let json = serde_json::to_string(&options).unwrap();
        let back: BoxOptions = serde_json::from_str(&json).unwrap();
        assert!(back.advanced.checkpoint_enabled);
        assert!(back.advanced.clone().checkpoint_enabled);
    }

    #[test]
    fn checkpoint_options_are_refused_off_linux_x86_64_and_without_default_isolation() {
        assert!(validate_options(&BoxOptions::default(), Host::current()).is_ok());
        assert!(validate_options(&checkpoint_options(), LINUX_X86).is_ok());

        for (os, arch) in [
            ("macos", "aarch64"),
            ("linux", "aarch64"),
            ("macos", "x86_64"),
        ] {
            let reason = reason(validate_options(&checkpoint_options(), Host { os, arch }));
            assert!(reason.contains(&format!("{os} {arch}")), "{reason}");
        }

        let mut options = checkpoint_options();
        options.advanced.security.jailer_enabled = false;
        assert!(reason(validate_options(&options, LINUX_X86)).contains("jailer_enabled"));

        let mut options = checkpoint_options();
        options.advanced.nested_virtualization = true;
        assert!(reason(validate_options(&options, LINUX_X86)).contains("nested"));

        let mut options = checkpoint_options();
        options.advanced.kernel = Some(crate::experimental::custom_kernel::KernelOptions::new(
            "/boot/vmlinux",
        ));
        assert!(reason(validate_options(&options, LINUX_X86)).contains("custom kernel"));

        let mut options = checkpoint_options();
        options.advanced.isolate_mounts = true;
        assert!(reason(validate_options(&options, LINUX_X86)).contains("isolate_mounts"));

        let mut options = checkpoint_options();
        options.secrets.push(crate::runtime::options::Secret {
            name: "openai".into(),
            value: "sk".into(),
            hosts: vec!["api.openai.com".into()],
            placeholder: "<BOXLITE_SECRET:openai>".into(),
        });
        assert!(reason(validate_options(&options, LINUX_X86)).contains("secrets"));

        let file = tempfile::NamedTempFile::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut options = checkpoint_options();
        options
            .volumes
            .push(crate::runtime::options::VolumeSpec::bind_mount(
                dir.path().to_str().unwrap(),
                "/data",
            ));
        assert!(
            validate_options(&options, LINUX_X86).is_ok(),
            "directories are fine"
        );
        options
            .volumes
            .push(crate::runtime::options::VolumeSpec::bind_mount(
                file.path().to_str().unwrap(),
                "/etc/app.conf",
            ));
        assert!(reason(validate_options(&options, LINUX_X86)).contains("single file"));

        let mut options = checkpoint_options();
        options.cpus = Some(129);
        assert!(reason(validate_options(&options, LINUX_X86)).contains("129 vCPUs"));
        options.cpus = Some(128);
        assert!(validate_options(&options, LINUX_X86).is_ok());
    }

    #[test]
    fn checkpoint_options_are_refused_by_create_validation_on_unsupported_hosts() {
        let result = checkpoint_options().sanitize_common();
        if Host::current() == LINUX_X86 {
            assert!(result.is_ok(), "{result:?}");
        } else {
            assert!(
                matches!(result, Err(BoxliteError::Unsupported(_))),
                "{result:?}"
            );
        }
    }

    #[test]
    fn checkpoint_launch_refuses_what_the_snapshot_owner_cannot_restore() {
        assert!(validate_spec(&spec()).is_ok());
        let mut plain = spec();
        plain.checkpoint = None;
        plain.disable_network = false;
        plain.nested_virtualization = true;
        assert!(
            validate_spec(&plain).is_ok(),
            "ordinary launches are untouched"
        );

        let mut tsi = spec();
        tsi.disable_network = false;
        assert!(reason(validate_spec(&tsi)).contains("TSI"));

        let mut engine = spec();
        engine.engine = VmmKind::Firecracker;
        assert!(reason(validate_spec(&engine)).contains("Firecracker"));

        let mut jailer = spec();
        jailer.security.jailer_enabled = false;
        assert!(reason(validate_spec(&jailer)).contains("jailer_enabled"));

        // The engine adds the guest root (`/dev/root`) to every cold boot, so
        // six more shares fill the owner's seven.
        let mut shares = spec();
        for i in 0..MAX_SHARES - 1 {
            shares
                .fs_shares
                .add(format!("s{i}"), PathBuf::from("/s"), false);
        }
        assert!(
            validate_spec(&shares).is_ok(),
            "six shares and the root fit"
        );
        shares.fs_shares.add("s6", PathBuf::from("/s"), false);
        assert!(reason(validate_spec(&shares)).contains("7 filesystem shares"));

        let mut disks = spec();
        for i in 0..MAX_DISKS_AND_NIC {
            disks.block_devices.add(disk(i));
        }
        assert!(validate_spec(&disks).is_ok(), "8 disks fit without a NIC");
        disks.disable_network = false;
        disks.network_backend_spec = Some(crate::net::NetworkBackendSpec {
            outbound_disabled: false,
            socket_path: PathBuf::from("/tmp/net.sock"),
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_cert_pem: None,
            ca_key_pem: None,
            rate_limit: Default::default(),
        });
        assert!(reason(validate_spec(&disks)).contains("8 disks (at most 7)"));

        let mut console = spec();
        console.console_output = None;
        assert!(reason(validate_spec(&console)).contains("console"));

        let mut cpus = spec();
        cpus.cpus = Some(0);
        assert!(reason(validate_spec(&cpus)).contains("0 vCPUs"));
    }
}
