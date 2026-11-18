// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Machine configuration and boundary validation.

use std::path::PathBuf;

use crate::{
    error::{Error, Result},
    memory::MAX_MEMORY_MIB,
};

/// Largest vCPU count a guest can use. The M1 guest kernel configuration sets
/// `CONFIG_NR_CPUS=64`, so further vCPUs would never run guest code; the
/// count also stays well under the 254 xAPIC ids an x86 MP table can list.
pub(crate) const MAX_VCPUS: u8 = 64;

/// Bytes of the command line the kernel copies, NUL included
/// (`COMMAND_LINE_SIZE` in `arch/x86/include/asm/setup.h`).
pub(crate) const MAX_CMDLINE_BYTES: usize = 2048;

/// How many disks a VM may have.
pub(crate) const MAX_DISKS: usize = 8;

/// The format of a disk image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiskFormat {
    /// A flat image: byte `n` of the file is byte `n` of the disk.
    Raw,
    /// A qcow2 image; the backing file its header names is read through.
    Qcow2,
}

/// A disk image the guest sees as a virtio-blk device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiskConfig {
    /// The image file.
    pub path: PathBuf,
    /// The image format, stated rather than probed: the runtime always knows
    /// what it created.
    pub format: DiskFormat,
    /// Whether the guest may write to it.
    pub read_only: bool,
}

/// The machine the VMM builds. The M2 engine adapter fills it from the
/// runtime's `InstanceSpec`, whose `memory_mib` field shares the name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmConfig {
    /// Number of vCPUs online at boot, `1..=max_vcpus`.
    pub vcpu_count: u8,
    /// Number of vCPUs the guest's topology lists, `vcpu_count..=MAX_VCPUS`.
    /// The rest stay parked, with no thread, until the host grants them.
    pub max_vcpus: u8,
    /// Guest RAM in MiB, `1..=MAX_MEMORY_MIB`.
    pub memory_mib: u32,
    /// The ELF kernel image to load.
    pub kernel: PathBuf,
    /// The kernel command line: printable ASCII, under `MAX_CMDLINE_BYTES`.
    pub cmdline: String,
    /// The uncompressed newc archive to load as the initramfs, if any.
    pub initramfs: Option<PathBuf>,
    /// The disks, in order: disk 0 is `vda`, disk 1 is `vdb`, and so on;
    /// `Vm::new` names each one on the command line so the kernel probes it.
    pub disks: Vec<DiskConfig>,
    /// Aggregate filesystem device, fixed for the lifetime of this VM.
    pub filesystem: Option<FsConfig>,
    /// Explicit Unix bridges for guest RPC and readiness.
    pub vsock: Option<VsockConfig>,
    /// Linux gvproxy stream endpoint and its configured guest MAC.
    pub network: Option<NetConfig>,
    /// Send hvc0 output to the supplied console sink.
    pub virtio_console: bool,
}

/// One virtio-fs device exposing the configured host directories.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsConfig {
    /// The tag the guest uses when mounting this device.
    pub tag: String,
    /// Export keys, authorized host paths and independent read-only policies.
    pub shares: Vec<FsShareConfig>,
}

/// One directory beneath the aggregate filesystem root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsShareConfig {
    pub name: String,
    pub path: PathBuf,
    pub read_only: bool,
}

/// Unix socket mappings exposed by the stream-only vsock device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VsockConfig {
    pub cid: u64,
    /// Host listeners forwarding connections to guest ports.
    pub listen: Vec<(u32, PathBuf)>,
    /// Guest connections to host ports forwarding to existing host sockets.
    pub connect: Vec<(u32, PathBuf)>,
}

/// A virtio-net interface connected to a Linux gvproxy stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetConfig {
    pub path: PathBuf,
    pub mac: [u8; 6],
}

impl VmConfig {
    /// The command line the kernel gets: `cmdline`, plus `maxcpus=` when
    /// some listed vCPUs start parked, so Linux brings up only the online ones.
    #[cfg_attr(
        not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
        expect(
            dead_code,
            reason = "Only the Linux x86_64 boot path writes the command line yet."
        )
    )]
    pub(crate) fn kernel_cmdline(&self) -> Result<std::borrow::Cow<'_, str>> {
        if self.max_vcpus == self.vcpu_count {
            return Ok(self.cmdline.as_str().into());
        }
        let cmdline = format!("{} maxcpus={}", self.cmdline, self.vcpu_count);
        if cmdline.len() >= MAX_CMDLINE_BYTES {
            return Err(Error::InvalidCommandLine("2048 bytes or longer"));
        }
        Ok(cmdline.into())
    }

    /// Rejects counts, sizes and command-line text the layout or the kernel
    /// cannot take, before any host call. The budget for the
    /// `virtio_mmio.device=` arguments that `devices::add_all` prepends is
    /// checked in `add_all`, after the host VM and the disk images exist.
    pub(crate) fn validate(&self) -> Result<()> {
        if !(1..=MAX_VCPUS).contains(&self.vcpu_count) {
            return Err(Error::InvalidVcpuCount(self.vcpu_count));
        }
        if !(self.vcpu_count..=MAX_VCPUS).contains(&self.max_vcpus) {
            return Err(Error::InvalidMaxVcpus {
                max: self.max_vcpus,
                online: self.vcpu_count,
            });
        }
        if !(1..=MAX_MEMORY_MIB).contains(&self.memory_mib) {
            return Err(Error::InvalidMemorySize(self.memory_mib));
        }
        if self.disks.len() > MAX_DISKS {
            return Err(Error::InvalidDiskCount(self.disks.len()));
        }
        if self.cmdline.len() >= MAX_CMDLINE_BYTES {
            return Err(Error::InvalidCommandLine("2048 bytes or longer"));
        }
        // linux-loader's `Cmdline` refuses anything else once it has trimmed
        // surrounding whitespace.
        if !self
            .cmdline
            .bytes()
            .all(|byte| (b' '..=b'~').contains(&byte))
        {
            return Err(Error::InvalidCommandLine("not printable ASCII"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::error::Error as _;

    use super::{DiskConfig, DiskFormat, MAX_CMDLINE_BYTES, MAX_DISKS, MAX_VCPUS, VmConfig};
    use crate::{error::Error, memory::MAX_MEMORY_MIB};

    fn config(vcpu_count: u8, memory_mib: u32) -> VmConfig {
        VmConfig {
            vcpu_count,
            max_vcpus: vcpu_count,
            memory_mib,
            kernel: "vmlinux".into(),
            cmdline: "console=ttyS0".into(),
            initramfs: None,
            disks: Vec::new(),
            filesystem: None,
            vsock: None,
            network: None,
            virtio_console: false,
        }
    }

    #[test]
    fn rejects_more_disks_than_the_slots_and_names_can_take() {
        let disk = DiskConfig {
            path: "disk.raw".into(),
            format: DiskFormat::Raw,
            read_only: false,
        };
        VmConfig {
            disks: vec![disk.clone(); MAX_DISKS],
            ..config(1, 1)
        }
        .validate()
        .unwrap();
        let error = VmConfig {
            disks: vec![disk; MAX_DISKS + 1],
            ..config(1, 1)
        }
        .validate()
        .unwrap_err();
        assert!(matches!(error, Error::InvalidDiskCount(n) if n == MAX_DISKS + 1));
        assert_eq!(error.to_string(), "too many disks: 9");
        assert!(error.source().is_none());
    }

    #[test]
    fn rejects_command_lines_the_kernel_cannot_take() {
        let with = |cmdline: String| VmConfig {
            cmdline,
            ..config(1, 1)
        };
        with("a".repeat(MAX_CMDLINE_BYTES - 1)).validate().unwrap();
        for (cmdline, reason) in [
            ("a".repeat(MAX_CMDLINE_BYTES), "2048 bytes or longer"),
            ("console=ttyS0\0".into(), "not printable ASCII"),
            ("console=ttyS0\n".into(), "not printable ASCII"),
        ] {
            let error = with(cmdline).validate().unwrap_err();
            assert!(matches!(error, Error::InvalidCommandLine(_)));
            assert_eq!(
                error.to_string(),
                format!("invalid kernel command line: {reason}")
            );
        }
    }

    #[test]
    fn rejects_counts_and_sizes_outside_the_layout_with_typed_errors() {
        for (config, message) in [
            (config(0, 1), "invalid vCPU count: 0"),
            (config(65, 1), "invalid vCPU count: 65"),
            (config(1, 0), "invalid memory size: 0 MiB"),
            (config(1, 3073), "invalid memory size: 3073 MiB"),
        ] {
            let error = config.validate().unwrap_err();
            assert_eq!(error.to_string(), message);
            assert!(matches!(
                error,
                Error::InvalidVcpuCount(_) | Error::InvalidMemorySize(_)
            ));
            assert!(error.source().is_none(), "{config:?}");
        }
        config(1, 1).validate().unwrap();
        config(MAX_VCPUS, MAX_MEMORY_MIB).validate().unwrap();
    }

    #[test]
    fn the_maximum_spans_the_online_count_to_max_vcpus() {
        let with = |online, max_vcpus| VmConfig {
            max_vcpus,
            ..config(online, 1)
        };
        with(2, 2).validate().unwrap();
        with(1, MAX_VCPUS).validate().unwrap();
        for (online, max) in [(2, 1), (1, MAX_VCPUS + 1)] {
            let error = with(online, max).validate().unwrap_err();
            assert!(
                matches!(error, Error::InvalidMaxVcpus { max: m, online: o } if m == max && o == online),
                "{error:?}"
            );
            assert!(error.source().is_none());
        }
    }

    #[test]
    fn parked_vcpus_add_maxcpus_to_the_kernel_command_line() {
        let with = |cmdline: String, max_vcpus| VmConfig {
            cmdline,
            max_vcpus,
            ..config(2, 1)
        };
        let all_online = with("console=ttyS0".into(), 2);
        assert_eq!(all_online.kernel_cmdline().unwrap(), "console=ttyS0");
        let some_parked = with("console=ttyS0".into(), 4);
        assert_eq!(
            some_parked.kernel_cmdline().unwrap(),
            "console=ttyS0 maxcpus=2"
        );
        // " maxcpus=2" is 10 bytes; one byte more no longer fits.
        let room = MAX_CMDLINE_BYTES - 11;
        with("a".repeat(room), 4).kernel_cmdline().unwrap();
        assert!(matches!(
            with("a".repeat(room + 1), 4).kernel_cmdline(),
            Err(Error::InvalidCommandLine(_))
        ));
    }
}
