// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

use boxlite_hypervisor::{KvmVm, X86Vm};
use vm_memory::GuestAddress;

use super::{
    image::{Header, expect_eof},
    state::MachineState,
};
use crate::{
    Error, Result, Vm,
    cpu_features::X86MemoryCaps,
    memory::{GuestRam, X86_LAYOUT},
    virtio::worker::VirtioWorkers,
    vm::Startup,
};

pub(crate) fn from_paths(state_path: &Path, memory_path: &Path) -> Result<Vm<KvmVm>> {
    let mut state = File::open(state_path).map_err(Error::Snapshot)?;
    let mut memory = File::open(memory_path).map_err(Error::Snapshot)?;
    let header = Header::read(&mut state)?;
    let meta = memory.metadata().map_err(Error::Snapshot)?;
    if meta.is_file() && meta.len() != header.ram_len {
        return Err(Error::Snapshot(io::Error::new(
            io::ErrorKind::InvalidData,
            "snapshot memory file length does not match the header",
        )));
    }
    from_header(header, &mut state, &mut memory, prepare_kvm)
}

fn prepare_kvm(
    ranges: &[(GuestAddress, usize)],
) -> Result<impl FnOnce() -> boxlite_hypervisor::Result<KvmVm> + use<>> {
    let prepared = KvmVm::prepare()?;
    let caps = X86MemoryCaps::from_cpuid(prepared.supported_cpuid())
        .map_err(Error::HostMemoryCapability)?;
    // X86_LAYOUT returns ordered ranges with checked end addresses.
    let &(start, size) = ranges.last().expect("validated nonempty RAM");
    let end = start.0 + size as u64;
    if end > caps.physical_end {
        return Err(Error::Snapshot(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "snapshot RAM ends at GPA {end:#x}, beyond KVM exclusive limit {:#x}",
                caps.physical_end
            ),
        )));
    }
    Ok(move || KvmVm::from_prepared(prepared))
}

#[cfg(test)]
pub(super) fn from_readers<H, C>(
    state_reader: &mut impl Read,
    memory_reader: &mut impl Read,
    prepare: impl FnOnce(&[(GuestAddress, usize)]) -> Result<C>,
) -> Result<Vm<H>>
where
    H: X86Vm + 'static,
    C: FnOnce() -> boxlite_hypervisor::Result<H>,
{
    let header = Header::read(state_reader)?;
    from_header(header, state_reader, memory_reader, prepare)
}

fn from_header<H, C>(
    header: Header,
    state_reader: &mut impl Read,
    memory_reader: &mut impl Read,
    prepare: impl FnOnce(&[(GuestAddress, usize)]) -> Result<C>,
) -> Result<Vm<H>>
where
    H: X86Vm + 'static,
    C: FnOnce() -> boxlite_hypervisor::Result<H>,
{
    let ranges = X86_LAYOUT
        .ranges(header.ram_len)
        .map_err(|error| Error::Snapshot(io::Error::new(io::ErrorKind::InvalidData, error)))?;
    let machine = header.read_machine(state_reader)?;
    let create = prepare(&ranges)?;
    let ram = GuestRam::new(&ranges)?;
    ram.read_image(memory_reader)?;
    expect_eof(memory_reader, "trailing bytes in snapshot memory file")?;
    from_ram(ram, machine, create)
}

/// The factory must create a fresh host VM with no independent vCPUs.
pub(super) fn from_ram<H: X86Vm + 'static>(
    ram: GuestRam,
    machine: MachineState,
    create: impl FnOnce() -> boxlite_hypervisor::Result<H>,
) -> Result<Vm<H>> {
    Vm::with_ram(
        ram,
        machine.vcpus.len() as u8,
        create,
        true,
        VirtioWorkers::new,
        |_, _| Ok(()),
        Startup::Restore(Box::new(machine)),
    )
}
