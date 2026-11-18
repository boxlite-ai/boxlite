// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Backing-memory ownership and guest address layout.
//!
//! [`GuestRam`] allocates the RAM a VM uses and registers it with the host
//! hypervisor. It releases the backing only after every registration has been
//! removed again: a `GuestRam` dropped while a registration may still exist
//! leaks the backing instead, so the host VM never references freed memory.
//! Host-side users of guest memory hold clones of the shared [`Arc`] and go
//! through vm-memory's volatile access API, never plain references.

use std::{io, ptr::NonNull, sync::Arc};

use boxlite_hypervisor::{MemoryRegion, Vm};
use vm_memory::{GuestAddress, GuestMemoryBackend, GuestMemoryRegion, VolatileSlice};

use crate::error::{Error, Result};

/// The guest memory type every host-side user shares. Dirty-page tracking
/// (M8) changes this alias rather than every holder.
pub(crate) type GuestMemoryMmap = vm_memory::GuestMemoryMmap<()>;

/// Bytes per MiB.
const MIB: u64 = 1 << 20;

/// Alignment of guest RAM ranges, independent of the host page size.
const GUEST_PAGE_SIZE: u64 = 4 << 10;

/// Where the x86_64 32-bit MMIO hole begins: the VMM design and Firecracker
/// both reserve the gigabyte below 4 GiB for devices.
pub(crate) const MMIO_HOLE_START: u64 = 0xC000_0000;
/// End of the x86_64 32-bit MMIO hole and starting GPA of high RAM.
const MMIO_HOLE_END: u64 = 0x1_0000_0000;

/// Guest RAM starts at `start` and skips the optional half-open MMIO hole.
#[derive(Debug)]
pub(crate) struct RamLayout {
    start: u64,
    hole: Option<(u64, u64)>,
}

impl RamLayout {
    /// Compute the nonempty RAM ranges without allocating guest backing.
    /// The RAM start, size and any hole endpoints must be guest-page aligned.
    pub(crate) fn ranges(&self, size: u64) -> io::Result<Vec<(GuestAddress, usize)>> {
        assert!(self.start.is_multiple_of(GUEST_PAGE_SIZE));
        assert!(size.is_multiple_of(GUEST_PAGE_SIZE));
        let (low_len, high) = if let Some((hole_start, hole_end)) = self.hole {
            assert!(hole_start.is_multiple_of(GUEST_PAGE_SIZE));
            assert!(hole_end.is_multiple_of(GUEST_PAGE_SIZE));
            let low_capacity = hole_start
                .checked_sub(self.start)
                .filter(|_| hole_start < hole_end)
                .ok_or_else(|| io::Error::other("invalid guest RAM hole"))?;
            let high = size.checked_sub(low_capacity).map(|len| (hole_end, len));
            (size.min(low_capacity), high)
        } else {
            (size, None)
        };

        std::iter::once((self.start, low_len))
            .chain(high)
            .filter(|&(_, len)| len != 0)
            .map(|(start, len)| {
                start
                    .checked_add(len)
                    .ok_or_else(|| io::Error::other("guest RAM end GPA overflows"))?;
                Ok((
                    GuestAddress(start),
                    usize::try_from(len).map_err(io::Error::other)?,
                ))
            })
            .collect()
    }
}

#[cfg_attr(
    not(any(test, target_arch = "x86_64")),
    expect(dead_code, reason = "Cross-architecture RAM layout test input.")
)]
pub(crate) const X86_LAYOUT: RamLayout = RamLayout {
    start: 0,
    hole: Some((MMIO_HOLE_START, MMIO_HOLE_END)),
};
#[cfg_attr(
    not(any(test, target_arch = "aarch64")),
    expect(dead_code, reason = "Cross-architecture RAM layout test input.")
)]
// The interrupt controller, UART, RTC and device windows sit below RAM.
pub(crate) const ARM64_LAYOUT: RamLayout = RamLayout {
    start: 0x8000_0000,
    hole: None,
};

#[cfg(target_arch = "x86_64")]
const LAYOUT: RamLayout = X86_LAYOUT;
#[cfg(target_arch = "aarch64")]
const LAYOUT: RamLayout = ARM64_LAYOUT;

/// Guest physical address of the first RAM byte, for layout assertions.
#[cfg(test)]
pub(crate) const RAM_START: u64 = LAYOUT.start;

/// The guest RAM ranges for `memory_mib` on the target architecture.
pub(crate) fn ram_ranges(memory_mib: u32) -> Vec<(GuestAddress, usize)> {
    // Every u32 MiB count fits in usize on supported 64-bit hosts, and adding
    // either layout's start or hole cannot overflow the GPA space.
    LAYOUT
        .ranges(u64::from(memory_mib) * MIB)
        .expect("u32 MiB fits the target RAM layout")
}

/// Checks each nonempty RAM range against an exclusive GPA limit.
#[cfg_attr(
    not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
    expect(dead_code, reason = "Only Linux x86_64 preflights the RAM layout yet.")
)]
pub(crate) fn check_ram_end(
    memory_mib: u32,
    ranges: &[(GuestAddress, usize)],
    limit_end: u64,
    limit_name: &'static str,
) -> Result<()> {
    for &(start, len) in ranges.iter().filter(|(_, len)| *len != 0) {
        let end = start.0.checked_add(len as u64);
        if end.is_none_or(|end| end > limit_end) {
            return Err(Error::GuestMemoryAddressLimit {
                memory_mib,
                // An overflowing end cannot be represented in the error.
                end: end.unwrap_or(u64::MAX),
                limit_end,
                limit: limit_name,
            });
        }
    }
    Ok(())
}

/// Query once per reporting device; a failed query must not guess granularity.
pub(crate) fn host_page_size() -> io::Result<usize> {
    // SAFETY: sysconf only queries a numeric host setting.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if size <= 0 {
        return Err(io::Error::other(
            "sysconf(_SC_PAGESIZE) did not return a positive size",
        ));
    }
    Ok(size as usize)
}

/// How the VMM returns guest-reported free pages to the host.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReclaimPolicy {
    /// Discard the pages now with `MADV_DONTNEED`; a later guest access
    /// faults in a fresh zero page.
    #[default]
    Immediate,
    /// Mark the pages reclaimable with `MADV_FREE` (Linux). The kernel
    /// discards them only under memory pressure, so a guest that reuses them
    /// first does not fault. Linux may skip a range that covers only part of a
    /// large folio; guest pageblock-order reports normally cover whole blocks.
    /// Other hosts fall back to [`Self::Immediate`].
    Lazy,
}

/// Validated metadata borrowing a live mapping, never its contents.
#[derive(Clone, Copy)]
pub(crate) struct ReclaimRange<'a> {
    slice: VolatileSlice<'a>,
    pub(crate) offset: usize,
    pub(crate) len: usize,
    pub(crate) host_start: usize,
}

impl<'a> ReclaimRange<'a> {
    pub(crate) fn new(
        memory: &'a GuestMemoryMmap,
        address: GuestAddress,
        len: usize,
        page_size: usize,
    ) -> io::Result<Self> {
        let invalid = || {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid report backing or range",
            )
        };
        if len == 0 || page_size == 0 || address.0.checked_add(len as u64).is_none() {
            return Err(invalid());
        }
        let (mapping, region_address) = memory.to_region_addr(address).ok_or_else(invalid)?;
        if !mapping.owned()
            || mapping.file_offset().is_some()
            || mapping.flags() & libc::MAP_ANONYMOUS == 0
            || mapping.flags() & libc::MAP_PRIVATE == 0
            || mapping.flags() & libc::MAP_SHARED != 0
            || mapping.is_hugetlbfs() == Some(true)
        {
            return Err(invalid());
        }
        #[cfg(target_os = "linux")]
        if mapping.flags() & libc::MAP_HUGETLB != 0 {
            return Err(invalid());
        }
        // get_slice proves the entire raw range belongs to one region, even
        // when a neighbouring region has an adjacent GPA.
        let slice = mapping
            .get_slice(region_address, len)
            .map_err(|_| invalid())?;
        let start = slice.ptr_guard().as_ptr() as usize;
        start.checked_add(len).ok_or_else(invalid)?;
        let (offset, aligned_len) = interior_pages(start, len, page_size);
        let host_start = start.checked_add(offset).ok_or_else(invalid)?;
        host_start.checked_add(aligned_len).ok_or_else(invalid)?;
        Ok(Self {
            slice,
            offset,
            len: aligned_len,
            host_start,
        })
    }

    pub(crate) fn reclaim(self, policy: ReclaimPolicy) -> io::Result<()> {
        if self.len == 0 {
            return Ok(());
        }
        let guard = self.slice.ptr_guard_mut();
        #[cfg(target_os = "linux")]
        let advice = match policy {
            ReclaimPolicy::Immediate => libc::MADV_DONTNEED,
            ReclaimPolicy::Lazy => libc::MADV_FREE,
        };
        #[cfg(not(target_os = "linux"))]
        let advice = match policy {
            ReclaimPolicy::Immediate | ReclaimPolicy::Lazy => libc::MADV_DONTNEED,
        };
        // SAFETY: validation proved private anonymous owned backing and a
        // checked inward-aligned subrange. The borrowed volatile slice and
        // guard keep the mapping alive; no references to contents are formed.
        // `MADV_FREE` only marks the range reclaimable; the kernel drops it
        // under pressure, and a write before then cancels the marking.
        let result =
            unsafe { libc::madvise(guard.as_ptr().add(self.offset).cast(), self.len, advice) };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn interior_pages(start: usize, len: usize, page_size: usize) -> (usize, usize) {
    let offset = (page_size - start % page_size) % page_size;
    let remaining = len.saturating_sub(offset);
    (offset.min(len), remaining / page_size * page_size)
}

/// Guest RAM owned by the VMM.
#[derive(Debug)]
pub(crate) struct GuestRam {
    memory: Arc<GuestMemoryMmap>,
    /// Regions `0..mapped`, in ascending address order, may still have
    /// mappings with the host VM.
    mapped: usize,
}

impl GuestRam {
    /// Allocates zero-filled anonymous memory for `ranges`, which must be
    /// ascending and non-overlapping. Nothing is registered yet.
    /// `GuestMemoryMmap::from_ranges` calls `MmapRegion::new` separately for
    /// each region: fresh owned MAP_PRIVATE | MAP_ANONYMOUS mappings, without
    /// files, raw pointers or hugetlb. Distinct live allocations have disjoint
    /// host virtual ranges; this constructor creates no second GPA/HVA view of
    /// one allocation. Arc clones retain the same mapping. Kernel zero-page
    /// sharing or COW does not create another VMM mapping. Reporting rejects
    /// other backing kinds instead of extending this ownership contract.
    pub(crate) fn new(ranges: &[(GuestAddress, usize)]) -> Result<Self> {
        let bytes = ranges.iter().map(|(_, size)| *size as u64).sum();
        let memory =
            GuestMemoryMmap::from_ranges(ranges).map_err(|source| Error::AllocateMemory {
                bytes,
                source: io::Error::other(source),
            })?;
        Ok(Self {
            memory: Arc::new(memory),
            mapped: 0,
        })
    }

    /// The shared guest memory every host-side user clones.
    pub(crate) fn memory(&self) -> &Arc<GuestMemoryMmap> {
        &self.memory
    }

    /// The guest RAM ranges this instance backs, in ascending guest order.
    #[cfg_attr(
        not(all(target_os = "linux", target_arch = "x86_64")),
        expect(dead_code, reason = "Only Linux x86_64 prepares boot data yet.")
    )]
    pub(crate) fn ranges(&self) -> impl Iterator<Item = (GuestAddress, usize)> + '_ {
        self.memory
            .iter()
            .map(|region| (region.start_addr(), region.len() as usize))
    }

    /// Each RAM range as the hypervisor registers it, in ascending guest order.
    pub(crate) fn regions(&self) -> impl Iterator<Item = MemoryRegion> + '_ {
        self.memory.iter().map(|region| MemoryRegion {
            guest_addr: region.start_addr().0,
            // vm-memory rejects a failed mmap, so a region pointer is never null.
            host_addr: NonNull::new(region.as_ptr()).expect("mmap returned a null mapping"),
            size: region.len() as usize,
        })
    }

    /// Registers every region with `vm`, lowest address first. On failure,
    /// attempts to remove any registrations and returns the original error.
    ///
    /// # Panics
    ///
    /// Panics if regions are already registered: one backing may back only
    /// one guest range in one VM.
    pub(crate) fn map<V: Vm + ?Sized>(&mut self, vm: &V) -> Result<()> {
        assert!(self.mapped == 0, "guest RAM is already mapped");
        let regions: Vec<MemoryRegion> = self.regions().collect();
        for region in &regions {
            // SAFETY: the region is a private anonymous mapping this `GuestRam`
            // owns, and it backs only this guest range. The backing stays
            // mapped until `unmap` succeeds for every region: `Drop` leaks it
            // otherwise. Host-side access goes through vm-memory's volatile API
            // on `memory`, never through Rust references.
            if let Err(error) = unsafe { vm.map_memory(region) } {
                // The backend may keep slices it registered before the failure. Count this
                // region so the rollback below attempts it too; a failed removal keeps the
                // backing alive.
                self.mapped += 1;
                let _ = self.unmap(vm);
                return Err(error.into());
            }
            self.mapped += 1;
        }
        Ok(())
    }

    /// Removes the registered regions, highest address first. A failure keeps
    /// that region and the ones below it registered; calling again retries.
    pub(crate) fn unmap<V: Vm + ?Sized>(&mut self, vm: &V) -> Result<()> {
        while self.mapped > 0 {
            let region = self
                .regions()
                .nth(self.mapped - 1)
                .expect("registered region");
            vm.unmap_memory(&region)?;
            self.mapped -= 1;
        }
        Ok(())
    }
}

impl Drop for GuestRam {
    fn drop(&mut self) {
        if self.mapped > 0 {
            // The host VM may still reference the range; leaking beats freeing
            // memory the guest can still write.
            std::mem::forget(Arc::clone(&self.memory));
        }
    }
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../tests/memory/mod.rs"]
mod tests;
