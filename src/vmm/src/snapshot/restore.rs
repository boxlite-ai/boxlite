// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Read admission precedes host creation. Imported machines never boot.

use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

use boxlite_hypervisor::{KvmVm, X86Vm};
use vm_memory::GuestAddress;

use super::{image::Header, state::MachineState};
use crate::{
    Error, Result, Vm, VmHandle,
    cpu_features::X86MemoryCaps,
    memory::{GuestRam, X86_LAYOUT},
    virtio::worker::VirtioWorkers,
    vm::Startup,
};

pub(crate) fn from_kvm_path(path: &Path) -> Result<VmHandle<KvmVm>> {
    from_image(path, true, |ranges| {
        let prepared = KvmVm::prepare()?;
        let caps = X86MemoryCaps::from_cpuid(prepared.supported_cpuid())
            .map_err(Error::HostMemoryCapability)?;
        // RamLayout returns ascending ranges and checks each end for overflow.
        if let Some(&(start, size)) = ranges.last() {
            let end = start.0 + size as u64;
            if end > caps.physical_end {
                return Err(Error::Snapshot(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "snapshot RAM ends at GPA {end:#x}, beyond KVM exclusive limit {:#x}",
                        caps.physical_end
                    ),
                )));
            }
        }
        Ok(move || KvmVm::from_prepared(prepared))
    })
}

fn from_image<H, Create>(
    path: &Path,
    fresh_vm: bool,
    prepare: impl FnOnce(&[(GuestAddress, usize)]) -> Result<Create>,
) -> Result<VmHandle<H>>
where
    H: X86Vm + 'static,
    Create: FnOnce() -> boxlite_hypervisor::Result<H>,
{
    let mut file = File::open(path).map_err(Error::Snapshot)?;
    let file_len = file.metadata().map_err(Error::Snapshot)?.len();
    from_reader(&mut file, file_len, fresh_vm, prepare)
}

fn from_reader<H, Create>(
    reader: &mut impl Read,
    file_len: u64,
    fresh_vm: bool,
    prepare: impl FnOnce(&[(GuestAddress, usize)]) -> Result<Create>,
) -> Result<VmHandle<H>>
where
    H: X86Vm + 'static,
    Create: FnOnce() -> boxlite_hypervisor::Result<H>,
{
    let header = Header::read_from(reader, file_len)?;
    let machine = header.read_machine(reader)?;
    if header.ram_len == 0 {
        return Err(Error::Snapshot(io::Error::new(
            io::ErrorKind::InvalidInput,
            "missing RAM",
        )));
    }
    let ranges = X86_LAYOUT.ranges(header.ram_len).map_err(Error::Snapshot)?;
    let create = prepare(&ranges)?;
    let ram = GuestRam::new(&ranges)?;
    ram.read_image(reader)?;
    start(ram, machine, create, fresh_vm)
}

fn start<H: X86Vm + 'static>(
    ram: GuestRam,
    machine: MachineState,
    create: impl FnOnce() -> boxlite_hypervisor::Result<H>,
    fresh_vm: bool,
) -> Result<VmHandle<H>> {
    let count = machine.vcpus.len() as u8;
    Vm::with_ram(
        ram,
        count,
        create,
        fresh_vm,
        VirtioWorkers::new,
        |_, _| Ok(()),
        Startup::Restore(Box::new(machine)),
    )?
    .spawn()
}

#[cfg(test)]
fn from_path<H: X86Vm + 'static>(
    path: &Path,
    create: impl FnOnce() -> boxlite_hypervisor::Result<H>,
) -> Result<VmHandle<H>> {
    from_image(path, false, |_| Ok(create))
}

#[cfg(test)]
fn from_ram<H: X86Vm + 'static>(
    ram: GuestRam,
    machine: MachineState,
    create: impl FnOnce() -> boxlite_hypervisor::Result<H>,
) -> Result<VmHandle<H>> {
    start(ram, machine, create, false)
}

#[cfg(test)]
#[path = "../../tests/snapshot/restore.rs"]
mod tests;
