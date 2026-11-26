// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Machine configuration and boundary validation.

use std::path::PathBuf;

use crate::error::{Error, Result};

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
    /// Nonempty, unique host control ID; independent of guest enumeration.
    pub block_id: String,
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
    /// Guest RAM in MiB; must be nonzero and fit the host and boot layout.
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
    /// Hotplug capacity in MiB above `memory_mib`. Zero disables virtio-mem.
    /// A positive capacity must fit the guest's memory block alignment,
    /// physical address limits and available KVM memory slots.
    pub hotplug_mib: u32,
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
    #[cfg(test)]
    pub(crate) fn validate_device_less(&self) -> Result<()> {
        if !self.disks.is_empty()
            || self.filesystem.is_some()
            || self.vsock.is_some()
            || self.network.is_some()
            || self.virtio_console
            || self.hotplug_mib > 0
        {
            return Err(Error::Control {
                operation: "new_device_less",
                reason: crate::ControlReason::UnsupportedDevice,
            });
        }
        self.validate()
    }

    /// Compose the CPU boot limit on the kernel side of the init separator.
    #[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
    pub(crate) fn kernel_cmdline(&self) -> Result<std::borrow::Cow<'_, str>> {
        if self.max_vcpus == self.vcpu_count {
            return Ok(self.cmdline.as_str().into());
        }
        let mut quoted = false;
        let mut offset = 0;
        let mut separator = None;
        let mut has_maxcpus = false;
        for part in self.cmdline.split_inclusive(|character: char| {
            if character == '"' {
                quoted = !quoted;
            }
            !quoted && character.is_ascii_whitespace()
        }) {
            let start = offset;
            offset += part.len();
            let (name, value) = kernel_arg_parts(part.trim_end());
            if name == "--" && value.is_none() {
                separator = Some(start);
                break;
            }
            let count = || value.and_then(kernel_cpu_limit);
            match name {
                "maxcpus" if count() == Some(self.vcpu_count.into()) => has_maxcpus = true,
                "nr_cpus" | "nr-cpus" | "possible_cpus" | "possible-cpus"
                    if count().is_some_and(|n| n >= i32::from(self.max_vcpus)) => {}
                "maxcpus" | "nr_cpus" | "nr-cpus" | "possible_cpus" | "possible-cpus" | "nosmp"
                | "nolapic" | "disableapic" => {
                    return Err(Error::InvalidCommandLine("conflicting CPU boot limit"));
                }
                _ => {}
            }
        }
        if quoted {
            return Err(Error::InvalidCommandLine("unclosed quote"));
        }
        let cmdline: std::borrow::Cow<'_, str> = if has_maxcpus {
            self.cmdline.as_str().into()
        } else if let Some(separator) = separator {
            format!(
                "{}maxcpus={} {}",
                &self.cmdline[..separator],
                self.vcpu_count,
                &self.cmdline[separator..]
            )
            .into()
        } else {
            let args = self.cmdline.trim_end();
            let space = if args.is_empty() { "" } else { " " };
            format!("{args}{space}maxcpus={}", self.vcpu_count).into()
        };
        if cmdline.len() >= MAX_CMDLINE_BYTES {
            return Err(Error::InvalidCommandLine("2048 bytes or longer"));
        }
        Ok(cmdline)
    }

    /// Checks static configuration without calling the host. VM creation
    /// checks host and boot address limits before allocating RAM. The budget
    /// for the `virtio_mmio.device=` arguments that `devices::add_all` prepends is
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
        if self.memory_mib == 0 {
            return Err(Error::InvalidMemorySize(self.memory_mib));
        }
        if self.disks.len() > MAX_DISKS {
            return Err(Error::InvalidDiskCount(self.disks.len()));
        }
        for (index, disk) in self.disks.iter().enumerate() {
            if disk.block_id.is_empty()
                || self.disks[..index]
                    .iter()
                    .any(|other| other.block_id == disk.block_id)
            {
                return Err(Error::InvalidDiskId(disk.block_id.clone()));
            }
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
        if !(u64::from(self.hotplug_mib) << 20).is_multiple_of(crate::hotplug::SLOT_SIZE) {
            return Err(Error::InvalidHotplugSize(self.hotplug_mib));
        }
        Ok(())
    }
}

/// Linux's `next_arg` strips the opening argument and value quotes independently.
#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
fn kernel_arg_parts(argument: &str) -> (&str, Option<&str>) {
    let quoted_arg = argument.strip_prefix('"');
    let argument = quoted_arg
        .map(|arg| arg.strip_suffix('"').unwrap_or(arg))
        .unwrap_or(argument);
    let Some((name, value)) = argument
        .split_once('=')
        .filter(|(name, _)| !name.is_empty())
    else {
        return (argument, None);
    };
    let value = match value.strip_prefix('"') {
        Some(value) if quoted_arg.is_none() => value.strip_suffix('"').unwrap_or(value),
        Some(value) => value,
        None => value,
    };
    (name, Some(value))
}

/// Linux early SMP parameters use `get_option` with automatic radix selection.
#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
fn kernel_cpu_limit(value: &str) -> Option<i32> {
    let (digits, radix) = match value.as_bytes() {
        [b'0', b'x' | b'X', ..] => (&value[2..], 16),
        [b'0', ..] => (value, 8),
        _ => (value, 10),
    };
    if digits.starts_with(['+', '-']) {
        return None;
    }
    i32::from_str_radix(digits, radix).ok()
}

#[cfg(test)]
mod tests {
    use std::error::Error as _;

    use super::{DiskConfig, DiskFormat, MAX_CMDLINE_BYTES, MAX_DISKS, MAX_VCPUS, VmConfig};
    use crate::error::Error;

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
            hotplug_mib: 0,
        }
    }

    #[test]
    fn rejects_more_disks_than_the_slots_and_names_can_take() {
        let disk = DiskConfig {
            block_id: "container".into(),
            path: "disk.raw".into(),
            format: DiskFormat::Raw,
            read_only: false,
        };
        VmConfig {
            disks: (0..MAX_DISKS)
                .map(|index| DiskConfig {
                    block_id: format!("disk-{index}"),
                    ..disk.clone()
                })
                .collect(),
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
    fn static_validation_accepts_nonzero_memory_above_the_x86_low_ram_band() {
        assert!(config(MAX_VCPUS, u32::MAX).validate().is_ok());
        assert!(config(1, 3073).validate().is_ok());
    }

    #[test]
    fn rejects_invalid_counts_and_zero_memory_with_typed_errors() {
        for (config, message) in [
            (config(0, 1), "invalid vCPU count: 0"),
            (config(65, 1), "invalid vCPU count: 65"),
            (config(1, 0), "invalid memory size: 0 MiB"),
        ] {
            let error = config.validate().unwrap_err();
            assert_eq!(error.to_string(), message);
            assert!(matches!(
                error,
                Error::InvalidVcpuCount(_) | Error::InvalidMemorySize(0)
            ));
            assert!(error.source().is_none(), "{config:?}");
        }
        config(1, 1).validate().unwrap();
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
    fn elastic_cpu_limit_preserves_the_init_arguments() {
        let config = VmConfig {
            max_vcpus: 4,
            cmdline: r#"console=ttyS0 "TITLE=before -- after" -- maxcpus=3 nr_cpus=2"#.into(),
            ..config(1, 128)
        };
        assert_eq!(
            config.kernel_cmdline().unwrap(),
            r#"console=ttyS0 "TITLE=before -- after" maxcpus=1 -- maxcpus=3 nr_cpus=2"#,
        );
    }

    #[test]
    fn elastic_cpu_limit_rejects_conflicting_kernel_arguments() {
        for cmdline in ["maxcpus=2", "nr_cpus=2", "nosmp"] {
            let config = VmConfig {
                max_vcpus: 4,
                cmdline: cmdline.into(),
                ..config(1, 128)
            };
            assert!(matches!(
                config.kernel_cmdline(),
                Err(Error::InvalidCommandLine(_))
            ));
        }
    }

    #[test]
    fn elastic_cpu_limits_follow_linux_early_parameter_rules() {
        let cases = [
            ("maxcpus=010", false),
            ("nr_cpus=012", false),
            ("nr-cpus=2", false),
            (r#""nr_cpus="2"#, false),
            (r#"maxcpus=10 "maxcpus="2"#, false),
            ("possible_cpus=2", false),
            ("possible-cpus=2", false),
            ("nolapic", false),
            ("disableapic", false),
            ("maxcpus=+10", false),
            (r#"maxcpus=""10"""#, false),
            ("maxcpus=012 nr-cpus=0xC possible_cpus=12", true),
            (r#""maxcpus=0xa" nr_cpus="0120""#, true),
            (r#""maxcpus="0xA nr_cpus="0120""#, true),
        ];
        let mismatches: Vec<_> = cases
            .into_iter()
            .filter(|&(cmdline, valid)| {
                let config = VmConfig {
                    max_vcpus: 12,
                    cmdline: cmdline.into(),
                    ..config(10, 128)
                };
                let result = config.kernel_cmdline();
                if valid {
                    !matches!(result, Ok(actual) if actual == cmdline)
                } else {
                    !matches!(result, Err(Error::InvalidCommandLine(_)))
                }
            })
            .collect();
        assert!(
            mismatches.is_empty(),
            "unexpected CPU arguments: {mismatches:?}"
        );
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
