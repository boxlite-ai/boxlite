// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest boot loading. The VMM is the boot loader: it writes the boot data into
//! guest RAM itself and starts the boot vCPU at the kernel entry. [`prepare`]
//! loads the kernel with `elf`, writes the zero page and command line with
//! `params`, and sets up the x86_64 64-bit entry state with `entry`; the MP
//! table follows in a later M1 slice.

use std::{fs::File, io};

use boxlite_hypervisor::X86BootRegisters;

use crate::{
    config::VmConfig,
    error::{Error, Result},
    memory::{GuestRam, ram_ranges},
};

pub(crate) mod elf;
pub(crate) mod entry;
pub(crate) mod initramfs;
pub(crate) mod params;

/// The boot data the vCPU workers apply once [`prepare`] has filled guest RAM.
#[derive(Debug)]
pub(crate) struct BootSetup {
    /// The boot vCPU registers that enter the kernel in 64-bit mode.
    pub(crate) boot_regs: X86BootRegisters,
}

/// Loads `config.kernel` and `config.initramfs` (if set) into `ram`, writes the
/// zero page, its E820 map and the command line, then sets up the long-mode entry.
///
/// `ram` must be the fresh zero-filled layout for `config.memory_mib`. A
/// failure may have written RAM; discard it.
pub(crate) fn prepare(ram: &GuestRam, config: &VmConfig) -> Result<BootSetup> {
    let memory = ram.memory().as_ref();
    let load_kernel = |source: io::Error| Error::LoadKernel {
        path: config.kernel.clone(),
        source,
    };
    let mut kernel = File::open(&config.kernel).map_err(load_kernel)?;
    let loaded = elf::load_elf(memory, &mut kernel).map_err(load_kernel)?;
    let loaded_initramfs = match &config.initramfs {
        Some(path) => {
            let load_initramfs = |source: io::Error| Error::LoadInitramfs {
                path: path.clone(),
                source,
            };
            let mut file = File::open(path).map_err(load_initramfs)?;
            let ram_end = u64::from(config.memory_mib) << 20;
            Some(
                initramfs::load_initramfs(memory, &mut file, loaded.end, ram_end)
                    .map_err(load_initramfs)?,
            )
        }
        None => None,
    };
    let zero_page = params::write_boot_params(
        memory,
        &config.cmdline,
        &ram_ranges(config.memory_mib),
        loaded_initramfs,
    )
    .map_err(|source| Error::WriteBootData {
        what: "boot parameters",
        source,
    })?;
    let boot_regs = entry::long_mode_entry(memory, loaded.entry, zero_page).map_err(|source| {
        Error::WriteBootData {
            what: "boot GDT and page tables",
            source,
        }
    })?;
    Ok(BootSetup { boot_regs })
}

#[cfg(test)]
#[path = "../../tests/boot/mod.rs"]
mod tests;
