// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest boot loading. The VMM is the boot loader: it writes the boot data into
//! guest RAM itself and starts the boot vCPU at the kernel entry. [`prepare`]
//! loads the initramfs with `initramfs`, and per architecture:
//!
//! - x86_64: loads the kernel with `elf`, writes the zero page and command
//!   line with `params`, describes the vCPUs and the IOAPIC with `mptable`, and
//!   sets up the 64-bit entry state with `entry`;
//! - arm64: loads the `Image` with `image` and describes the machine in a
//!   device tree with `fdt`, in the last 2 MiB of RAM.

use std::{fs::File, io, path::Path};

use vm_memory::GuestAddress;

use crate::{
    config::VmConfig,
    error::{Error, Result},
    memory::{GuestMemoryMmap, GuestRam, ram_ranges},
    vm::BootRegisters,
};

#[cfg(target_arch = "x86_64")]
pub(crate) mod elf;
#[cfg(target_arch = "x86_64")]
pub(crate) mod entry;
#[cfg(target_arch = "aarch64")]
pub(crate) mod fdt;
#[cfg(target_arch = "aarch64")]
pub(crate) mod image;
pub(crate) mod initramfs;
#[cfg(target_arch = "x86_64")]
pub(crate) mod mptable;
#[cfg(target_arch = "x86_64")]
pub(crate) mod params;

/// The space for the device tree at the top of arm64 RAM: the most a device
/// tree may take (`booting.rst`). The MiB-sized RAM layout keeps it aligned
/// to the required eight bytes, including with an odd MiB count.
#[cfg(target_arch = "aarch64")]
const DEVICE_TREE_SIZE: u64 = 2 << 20;

/// The boot data the vCPU workers apply once [`prepare`] has filled guest RAM.
#[derive(Debug)]
pub(crate) struct BootSetup {
    /// The boot vCPU's entry registers.
    pub(crate) boot_regs: BootRegisters,
}

/// Loads `config.kernel` and, when set, `config.initramfs` into `ram`, writes
/// the zero page, its E820 map, the command line and the MP table for
/// `config.vcpu_count` vCPUs, then sets up the long-mode entry.
///
/// `ram` must be the fresh zero-filled layout for `config.memory_mib`. A
/// failure may have written RAM; discard it.
#[cfg(target_arch = "x86_64")]
pub(crate) fn prepare(ram: &GuestRam, config: &VmConfig) -> Result<BootSetup> {
    let memory = ram.memory().as_ref();
    let mut kernel = File::open(&config.kernel).map_err(|source| load_kernel(config, source))?;
    let entry = elf::load_elf(memory, &mut kernel).map_err(|source| load_kernel(config, source))?;
    let initramfs = load_initramfs_file(memory, config, ram_end(config))?;
    let zero_page = params::write_boot_params(
        memory,
        &config.cmdline,
        &ram_ranges(config.memory_mib),
        initramfs,
    )
    .map_err(|source| Error::WriteBootData {
        what: "boot parameters",
        source,
    })?;
    mptable::write_mptable(memory, config.vcpu_count).map_err(|source| Error::WriteBootData {
        what: "MP table",
        source,
    })?;
    let boot_regs = entry::long_mode_entry(memory, entry, zero_page).map_err(|source| {
        Error::WriteBootData {
            what: "boot GDT and page tables",
            source,
        }
    })?;
    Ok(BootSetup { boot_regs })
}

/// Loads `config.kernel`, an arm64 `Image`, at the RAM base, then
/// `config.initramfs` below the last 2 MiB of RAM, which take the device tree
/// for `config`, and points the boot vCPU at the kernel with X0 at the device
/// tree (`Documentation/arch/arm64/booting.rst`).
///
/// `ram` must be the fresh zero-filled layout for `config.memory_mib`. A
/// failure may have written RAM; discard it.
#[cfg(target_arch = "aarch64")]
pub(crate) fn prepare(ram: &GuestRam, config: &VmConfig) -> Result<BootSetup> {
    use vm_memory::Bytes;

    use crate::vcpu::PSTATE_EL1H_DAIF;

    let memory = ram.memory().as_ref();
    let mut kernel = File::open(&config.kernel).map_err(|source| load_kernel(config, source))?;
    let image =
        image::load_image(memory, &mut kernel).map_err(|source| load_kernel(config, source))?;
    let device_tree = GuestAddress(ram_end(config).0 - DEVICE_TREE_SIZE);
    let write_failed = |source| Error::WriteBootData {
        what: "device tree",
        source,
    };
    if image.end > device_tree {
        return Err(write_failed(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "the kernel claims memory up to {:#x}, past the device tree at {:#x}",
                image.end.0, device_tree.0
            ),
        )));
    }
    let initramfs = load_initramfs_file(memory, config, device_tree)?;
    if let Some((start, _)) = initramfs
        && start < image.end
        && let Some(path) = &config.initramfs
    {
        return Err(Error::LoadInitramfs {
            path: path.clone(),
            source: io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("it would start at {:#x}, inside the kernel", start.0),
            ),
        });
    }
    let blob = fdt::device_tree(config, initramfs).map_err(write_failed)?;
    if blob.len() as u64 > DEVICE_TREE_SIZE {
        return Err(write_failed(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} bytes exceed the 2 MiB a device tree may take",
                blob.len()
            ),
        )));
    }
    memory
        .write_slice(&blob, device_tree)
        .map_err(|error| write_failed(io::Error::other(error)))?;
    Ok(BootSetup {
        boot_regs: BootRegisters {
            pc: image.entry.0,
            x0: device_tree.0,
            pstate: PSTATE_EL1H_DAIF,
        },
    })
}

fn load_kernel(config: &VmConfig, source: io::Error) -> Error {
    Error::LoadKernel {
        path: config.kernel.clone(),
        source,
    }
}

/// The first address past the RAM layout for `config.memory_mib`.
fn ram_end(config: &VmConfig) -> GuestAddress {
    ram_ranges(config.memory_mib)
        .last()
        .map_or(GuestAddress(0), |&(start, size)| {
            GuestAddress(start.0 + size as u64)
        })
}

/// Loads `config.initramfs`, when set, in the highest page-aligned slot below
/// `end`, and returns its start and size.
fn load_initramfs_file(
    memory: &GuestMemoryMmap,
    config: &VmConfig,
    end: GuestAddress,
) -> Result<Option<(GuestAddress, usize)>> {
    let Some(path) = config.initramfs.as_ref() else {
        return Ok(None);
    };
    let load = |path: &Path| {
        let mut file = File::open(path)?;
        let size = usize::try_from(file.metadata()?.len()).map_err(io::Error::other)?;
        let start = initramfs::load_initramfs(memory, &mut file, size, end)?;
        Ok((start, size))
    };
    load(path).map(Some).map_err(|source| Error::LoadInitramfs {
        path: path.clone(),
        source,
    })
}

#[cfg(all(test, target_arch = "x86_64"))]
#[path = "../../tests/boot/mod.rs"]
mod tests;

#[cfg(all(test, target_arch = "aarch64"))]
#[path = "../../tests/arm64_boot/mod.rs"]
mod tests;
