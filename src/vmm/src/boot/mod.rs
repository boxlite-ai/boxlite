// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest boot loading. The VMM is the boot loader: it writes the boot data into
//! guest RAM itself and starts the boot vCPU at the kernel entry. [`prepare`]
//! loads the kernel with `elf` and the initramfs with `initramfs`, writes the
//! zero page and command line with `params`, describes the vCPUs and the IOAPIC
//! with `mptable`, and sets up the x86_64 64-bit entry state with `entry`.

use std::{fs::File, io, path::Path};

use boxlite_hypervisor::X86BootRegisters;
use vm_memory::GuestAddress;

use crate::{
    config::VmConfig,
    error::{Error, Result},
    memory::{GuestMemoryMmap, GuestRam},
    x86_boot_layout::{self, CheckedBootLeaf, PageSize},
};
#[cfg(target_os = "linux")]
use crate::{cpu_features::X86MemoryCaps, hotplug::HotplugWindow, memory::ram_ranges};

pub(crate) mod elf;
pub(crate) mod entry;
pub(crate) mod initramfs;
pub(crate) mod mptable;
pub(crate) mod params;

/// Internal leaf-size switch; any selected size must pass host preflight before use.
pub(crate) const BOOT_LEAF: PageSize = PageSize::Mib;

/// Checks boot RAM and plans the optional hotplug window against the same host
/// limits and backed ranges before VM construction.
#[cfg(target_os = "linux")]
pub(crate) fn preflight(
    config: &VmConfig,
    kvm: &boxlite_hypervisor::PreparedKvm,
) -> Result<(CheckedBootLeaf, Option<HotplugWindow>)> {
    let caps =
        X86MemoryCaps::from_cpuid(kvm.supported_cpuid()).map_err(Error::HostMemoryCapability)?;
    let ranges = ram_ranges(config.memory_mib);
    let leaf = caps.check_boot_leaf(config.memory_mib, &ranges, BOOT_LEAF)?;
    if config.hotplug_mib == 0 {
        return Ok((leaf, None));
    }

    let available_slots = kvm.memory_slots_after(ranges.iter().map(|&(_, size)| size));
    let window = HotplugWindow::plan(
        &ranges,
        config.hotplug_mib,
        caps.physical_end,
        available_slots,
    )
    .map_err(|source| Error::PlanHotplugMemory {
        capacity_mib: config.hotplug_mib,
        source,
    })?;
    Ok((leaf, Some(window)))
}

/// The boot data the vCPU workers apply once [`prepare`] has filled guest RAM.
#[derive(Debug)]
pub(crate) struct BootSetup {
    /// The boot vCPU registers that enter the kernel in 64-bit mode.
    pub(crate) boot_regs: X86BootRegisters,
}

/// Loads `config.kernel` and, when set, `config.initramfs` into `ram`, writes
/// the zero page, its E820 map, the command line and the MP table for
/// `config.max_vcpus` vCPUs, then sets up the long-mode entry.
///
/// `ram` must be fresh and zero-filled. Its backed ranges determine the E820
/// map, initramfs placement and identity mappings. A failure may have written
/// RAM; discard it.
pub(crate) fn prepare(
    ram: &GuestRam,
    config: &VmConfig,
    leaf: CheckedBootLeaf,
) -> Result<BootSetup> {
    let memory = ram.boot_memory().as_ref();
    let ranges: Vec<(GuestAddress, usize)> = ram.ranges().collect();
    let load_kernel = |source: io::Error| Error::LoadKernel {
        path: config.kernel.clone(),
        source,
    };
    let mut kernel = File::open(&config.kernel).map_err(load_kernel)?;
    let kernel = elf::load_elf(memory, &mut kernel).map_err(load_kernel)?;
    let initramfs = config
        .initramfs
        .as_ref()
        .map(|path| {
            load_initramfs_file(memory, &ranges, path).map_err(|source| Error::LoadInitramfs {
                path: path.clone(),
                source,
            })
        })
        .transpose()?;
    let table_error = |source| Error::WriteBootData {
        what: "boot GDT and page tables",
        source,
    };
    let plan = x86_boot_layout::plan_boot_tables(
        &ranges,
        (kernel.start, kernel.end),
        initramfs,
        leaf.page_size(),
    )
    .map_err(table_error)?;
    let fast = plan.tables().0 == x86_boot_layout::TABLES_BASE;
    let reserved = plan.reserved(fast);
    let cmdline = config.kernel_cmdline()?;
    let zero_page = params::write_boot_params(memory, &cmdline, &ranges, initramfs, &reserved)
        .map_err(|source| Error::WriteBootData {
            what: "boot parameters",
            source,
        })?;
    mptable::write_mptable(memory, config.max_vcpus).map_err(|source| Error::WriteBootData {
        what: "MP table",
        source,
    })?;
    let boot_regs =
        entry::long_mode_entry(memory, kernel.entry, zero_page, &plan).map_err(table_error)?;
    Ok(BootSetup { boot_regs })
}

/// Loads the whole file at `path` as the initramfs and returns its start and
/// size.
fn load_initramfs_file(
    memory: &GuestMemoryMmap,
    ranges: &[(GuestAddress, usize)],
    path: &Path,
) -> io::Result<(GuestAddress, usize)> {
    let mut file = File::open(path)?;
    let size = usize::try_from(file.metadata()?.len()).map_err(io::Error::other)?;
    let start = initramfs::load_initramfs(memory, ranges, &mut file, size)?;
    Ok((start, size))
}

#[cfg(test)]
#[path = "../../tests/boot/mod.rs"]
mod tests;
