// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{io, ptr};

use super::{
    HvfVcpu, check,
    ffi::{self, GicCalls},
};
use crate::{Error, MemoryRegion, Result};

/// The process's HVF VM and its in-kernel GICv3.
///
/// Hypervisor.framework holds one VM per process: creating a second fails
/// with `ResourceBusy` until the first is dropped. Memory backing remains
/// owned by the caller, under the contract of [`crate::Vm::map_memory`].
/// Dropping this value destroys the VM, its GIC and its mappings; every vCPU
/// must be dropped first.
#[derive(Debug)]
pub struct HvfVm {
    gic: &'static GicCalls,
}

impl HvfVm {
    /// Creates the VM and its GICv3, with the distributor at `distributor`
    /// and the redistributor region, which HVF sizes for every vCPU it
    /// supports, at `redistributors`. Fails with `Unsupported` on macOS 12 to
    /// 14, which lack the in-kernel GIC, and with `InvalidInput` for bases HVF
    /// cannot use, and leaves no VM behind on any failure.
    pub fn new(distributor: u64, redistributors: u64) -> Result<Self> {
        let gic = GicCalls::get().map_err(Error::CreateVm)?;
        // SAFETY: a null configuration selects HVF's defaults.
        check(unsafe { ffi::hv_vm_create(ptr::null_mut()) }).map_err(Error::CreateVm)?;
        // From here `Drop` destroys the VM if the GIC fails.
        let vm = Self { gic };
        create_gic(gic, distributor, redistributors).map_err(Error::CreateVm)?;
        Ok(vm)
    }

    /// Maps caller-owned RAM at a guest physical address, readable, writable
    /// and executable.
    ///
    /// # Safety
    ///
    /// The caller must uphold [`crate::Vm::map_memory`]'s backing-memory,
    /// aliasing, synchronization and lifetime requirements.
    pub unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        let flags = ffi::HV_MEMORY_READ | ffi::HV_MEMORY_WRITE | ffi::HV_MEMORY_EXEC;
        // SAFETY: the caller keeps the backing valid, and only guest-safe
        // accesses touch it, until the mapping is gone.
        let code = unsafe {
            ffi::hv_vm_map(
                region.host_addr.as_ptr().cast(),
                region.guest_addr,
                region.size,
                flags,
            )
        };
        check(code).map_err(|source| Error::MapMemory {
            guest_addr: region.guest_addr,
            size: region.size,
            source,
        })
    }

    /// Removes a mapping added with [`map_memory`](Self::map_memory).
    pub fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        // SAFETY: removing a guest mapping touches no host memory.
        let code = unsafe { ffi::hv_vm_unmap(region.guest_addr, region.size) };
        check(code).map_err(|source| Error::UnmapMemory {
            guest_addr: region.guest_addr,
            size: region.size,
            source,
        })
    }

    /// Creates vCPU `id` on the calling thread, which alone may use it.
    pub fn create_vcpu(&self, id: u32) -> Result<HvfVcpu> {
        HvfVcpu::new(id)
    }

    /// Sets SPI `line` of the in-kernel GIC, from any thread. A vCPU waiting
    /// in WFI wakes inside HVF, so nothing else needs waking.
    pub fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
        // SAFETY: HVF checks the INTID against its SPI range.
        check(unsafe { (self.gic.set_spi)(line, level) })
            .map_err(|source| Error::SetIrqLine { line, source })
    }
}

impl Drop for HvfVm {
    fn drop(&mut self) {
        // A failure, with a vCPU still alive, leaves the VM to the process,
        // and the next `new` then reports `ResourceBusy`.
        // SAFETY: the process's VM exists while `self` does.
        let _ = check(unsafe { ffi::hv_vm_destroy() });
    }
}

/// Creates the GIC once HVF's alignments allow both bases and the
/// redistributor region stays clear of the distributor (`hv_gic_config.h`).
fn create_gic(gic: &GicCalls, distributor: u64, redistributors: u64) -> io::Result<()> {
    let query = |get: unsafe extern "C" fn(*mut usize) -> ffi::hv_return_t| {
        let mut value = 0;
        // SAFETY: HVF writes one value through the pointer.
        check(unsafe { get(&mut value) }).map(|()| value as u64)
    };
    let distributor_size = query(gic.get_distributor_size)?;
    let distributor_alignment = query(gic.get_distributor_base_alignment)?;
    let region_size = query(gic.get_redistributor_region_size)?;
    let region_alignment = query(gic.get_redistributor_base_alignment)?;
    let invalid = |reason: String| io::Error::new(io::ErrorKind::InvalidInput, reason);
    if !distributor.is_multiple_of(distributor_alignment)
        || !redistributors.is_multiple_of(region_alignment)
    {
        return Err(invalid(format!(
            "GIC bases {distributor:#x} and {redistributors:#x} must align to \
             {distributor_alignment:#x} and {region_alignment:#x}"
        )));
    }
    let overlaps = |base: u64, size: u64, other: u64, other_size: u64| {
        base < other.saturating_add(other_size) && other < base.saturating_add(size)
    };
    if overlaps(redistributors, region_size, distributor, distributor_size) {
        return Err(invalid(format!(
            "the {region_size:#x}-byte redistributor region at {redistributors:#x} \
             overlaps the distributor at {distributor:#x}"
        )));
    }
    // SAFETY: the configuration object is created, used and released here.
    unsafe {
        let config = (gic.config_create)();
        if config.is_null() {
            return Err(io::Error::other("hv_gic_config_create returned no object"));
        }
        let created = check((gic.config_set_distributor_base)(config, distributor))
            .and_then(|()| check((gic.config_set_redistributor_base)(config, redistributors)))
            .and_then(|()| check((gic.create)(config)));
        ffi::os_release(config);
        created
    }
}

impl crate::Vm for HvfVm {
    type Vcpu = HvfVcpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        // SAFETY: the trait caller guarantees the same backing-memory contract.
        unsafe { Self::map_memory(self, region) }
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        Self::unmap_memory(self, region)
    }

    fn create_vcpu(&self, id: u32) -> Result<Self::Vcpu> {
        Self::create_vcpu(self, id)
    }

    fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
        Self::set_irq_line(self, line, level)
    }
}
