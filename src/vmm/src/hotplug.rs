// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Hotplug memory above the boot RAM.
//!
//! [`HotplugMemory`] owns a guest-physical window that a virtio-mem driver
//! plugs and unplugs in [`BLOCK_SIZE`] blocks. The VMM backs and registers it
//! in [`SLOT_SIZE`] slots: a slot gains its own anonymous mapping and KVM
//! registration when its first block is plugged, and loses both when its last
//! block is unplugged. An unplugged block inside a still-mapped slot is
//! discarded with `MADV_DONTNEED`. The host memory bound is therefore the
//! mapped slots, not the plugged blocks.
//!
//! Every change publishes a new [`GuestMemoryView`], so devices see a slot from
//! their next snapshot on. Removal runs KVM unregistration, then the view
//! update, then drops the mapping, which a snapshot still in use keeps alive.

use std::{
    convert::Infallible,
    io,
    ops::Range,
    ptr::NonNull,
    sync::{Arc, PoisonError},
};

use boxlite_hypervisor::{MemoryRegion, Vm};
use vm_memory::{GuestAddress, GuestAddressSpace, GuestMemoryRegion, GuestRegionMmap};

use crate::memory::{GuestMemoryMmap, GuestMemoryView};

const MIB: u64 = 1 << 20;

/// The virtio-mem device block: the unit the guest plugs and unplugs.
pub(crate) const BLOCK_SIZE: u64 = 2 * MIB;

/// The unit of host mapping and KVM registration; also the capacity step.
pub(crate) const SLOT_SIZE: u64 = 128 * MIB;

const BLOCKS_PER_SLOT: usize = (SLOT_SIZE / BLOCK_SIZE) as usize;

/// Where the window starts on x86_64: above the 32-bit MMIO hole, outside
/// every boot RAM range and E820 entry.
pub(crate) const HOTPLUG_START: u64 = 1 << 32;

/// Whether `capacity_mib` is a positive multiple of a slot whose window ends
/// within the host's physical address width, which bounds the guest's.
pub(crate) fn capacity_fits(capacity_mib: u32) -> bool {
    let size = u64::from(capacity_mib) * MIB;
    size != 0
        && size.is_multiple_of(SLOT_SIZE)
        && HOTPLUG_START
            .checked_add(size)
            .is_some_and(|end| end <= 1 << physical_address_bits())
}

/// CPUID 0x8000_0008 EAX[7:0], or 36 bits when the leaf is absent.
#[cfg(target_arch = "x86_64")]
fn physical_address_bits() -> u32 {
    use std::arch::x86_64::__cpuid;
    if __cpuid(0x8000_0000).eax < 0x8000_0008 {
        return 36;
    }
    __cpuid(0x8000_0008).eax & 0xff
}

#[cfg(not(target_arch = "x86_64"))]
fn physical_address_bits() -> u32 {
    36
}

/// Whether a block range is plugged, unplugged or both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BlockState {
    Plugged,
    Unplugged,
    Mixed,
}

/// The hotplug window, its mapped slots and its plugged blocks.
pub(crate) struct HotplugMemory<V: Vm + ?Sized> {
    vm: Arc<V>,
    view: GuestMemoryView,
    base: u64,
    slots: Vec<Option<Arc<GuestRegionMmap>>>,
    plugged: Vec<bool>,
}

impl<V: Vm + ?Sized> HotplugMemory<V> {
    /// An empty window of `capacity_mib` at [`HOTPLUG_START`]. Nothing is
    /// mapped or registered until a plug.
    pub(crate) fn new(vm: Arc<V>, view: GuestMemoryView, capacity_mib: u32) -> io::Result<Self> {
        if !capacity_fits(capacity_mib) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "hotplug capacity must be a positive multiple of 128 MiB within the address width",
            ));
        }
        let size = u64::from(capacity_mib) * MIB;
        let slots = (size / SLOT_SIZE) as usize;
        Ok(Self {
            vm,
            view,
            base: HOTPLUG_START,
            slots: vec![None; slots],
            plugged: vec![false; slots * BLOCKS_PER_SLOT],
        })
    }

    /// The first guest address of the window.
    pub(crate) fn base(&self) -> u64 {
        self.base
    }

    /// The window size in bytes.
    pub(crate) fn size(&self) -> u64 {
        self.slots.len() as u64 * SLOT_SIZE
    }

    /// Bytes in plugged blocks.
    pub(crate) fn plugged_bytes(&self) -> u64 {
        self.plugged.iter().filter(|&&plugged| plugged).count() as u64 * BLOCK_SIZE
    }

    /// Bytes in mapped slots: the host memory the guest can reach.
    pub(crate) fn mapped_bytes(&self) -> u64 {
        self.slots.iter().flatten().count() as u64 * SLOT_SIZE
    }

    /// The block indexes of `count` blocks at `addr`, or `None` when the range
    /// is empty, misaligned or outside the window.
    pub(crate) fn blocks(&self, addr: u64, count: u16) -> Option<Range<usize>> {
        let offset = addr.checked_sub(self.base)?;
        let end = offset.checked_add(u64::from(count) * BLOCK_SIZE)?;
        if count == 0 || !offset.is_multiple_of(BLOCK_SIZE) || end > self.size() {
            return None;
        }
        Some((offset / BLOCK_SIZE) as usize..(end / BLOCK_SIZE) as usize)
    }

    /// The state of `blocks`, which [`Self::blocks`] produced.
    pub(crate) fn state(&self, blocks: Range<usize>) -> BlockState {
        let plugged = self.plugged[blocks.clone()].iter().filter(|&&p| p).count();
        match plugged {
            0 => BlockState::Unplugged,
            n if n == blocks.len() => BlockState::Plugged,
            _ => BlockState::Mixed,
        }
    }

    /// Plugs `blocks`, mapping and registering every slot they need. A failure
    /// unregisters the slots this call added and leaves every block unplugged.
    pub(crate) fn plug(&mut self, blocks: Range<usize>) -> io::Result<()> {
        let mut added = Vec::new();
        for slot in slots_of(&blocks) {
            if self.slots[slot].is_some() {
                continue;
            }
            match self.map_slot(slot) {
                Ok(region) => added.push((slot, region)),
                Err(error) => {
                    for (slot, region) in added.into_iter().rev() {
                        self.release(slot, region);
                    }
                    return Err(error);
                }
            }
        }
        if !added.is_empty() {
            let mut regions = added.iter().map(|(_, region)| Arc::clone(region));
            let published = self.publish(|map| {
                regions.try_fold(map, |map, region| {
                    map.insert_region(region).map_err(io::Error::other)
                })
            });
            if let Err(error) = published {
                for (slot, region) in added.into_iter().rev() {
                    self.release(slot, region);
                }
                return Err(error);
            }
        }
        for (slot, region) in added {
            self.slots[slot] = Some(region);
        }
        self.plugged[blocks].fill(true);
        Ok(())
    }

    /// Unplugs `blocks`. A slot left empty is unregistered, removed from the
    /// view and dropped; blocks in a slot that stays mapped are discarded.
    /// A failed unregistration keeps that slot mapped.
    pub(crate) fn unplug(&mut self, blocks: Range<usize>) -> io::Result<()> {
        self.plugged[blocks.clone()].fill(false);
        let mut emptied = Vec::new();
        let mut result = Ok(());
        for slot in slots_of(&blocks) {
            let Some(region) = self.slots[slot].clone() else {
                continue;
            };
            let whole = slot * BLOCKS_PER_SLOT..(slot + 1) * BLOCKS_PER_SLOT;
            if self.plugged[whole.clone()].iter().any(|&p| p) {
                let start = blocks.start.max(whole.start);
                let end = blocks.end.min(whole.end);
                if let Err(error) = discard(&region, start - whole.start, end - start) {
                    result = Err(error);
                }
            } else if let Err(error) = self.vm.unmap_memory(&kvm_region(&region)) {
                result = Err(io::Error::other(error));
            } else {
                emptied.push((slot, region));
            }
        }
        if !emptied.is_empty() {
            let removed: Vec<_> = emptied.iter().map(|(_, r)| r.start_addr()).collect();
            // Removal cannot fail: KVM no longer maps these slots, so the view
            // and the slot records must follow. A region already missing from
            // the view counts as removed.
            let Ok(()) = self.publish::<Infallible>(|map| {
                Ok(removed.iter().fold(map, |map, &start| {
                    map.remove_region(start, SLOT_SIZE)
                        .map(|(map, _)| map)
                        .unwrap_or(map)
                }))
            });
            for (slot, _) in emptied {
                self.slots[slot] = None;
            }
        }
        result
    }

    /// Unplugs every block.
    pub(crate) fn unplug_all(&mut self) -> io::Result<()> {
        self.unplug(0..self.plugged.len())
    }

    fn map_slot(&self, slot: usize) -> io::Result<Arc<GuestRegionMmap>> {
        let addr = GuestAddress(self.base + slot as u64 * SLOT_SIZE);
        let region = GuestRegionMmap::from_range(addr, SLOT_SIZE as usize, None)
            .map_err(io::Error::other)?;
        let region = Arc::new(region);
        // SAFETY: the mapping is private anonymous memory this owner keeps
        // alive until the registration is removed; `Drop` leaks it otherwise.
        // Host access goes through vm-memory's volatile API.
        unsafe { self.vm.map_memory(&kvm_region(&region)) }.map_err(io::Error::other)?;
        Ok(region)
    }

    /// Unregisters a slot that never reached the view; leaks it on failure.
    fn release(&self, slot: usize, region: Arc<GuestRegionMmap>) {
        if self.vm.unmap_memory(&kvm_region(&region)).is_err() {
            tracing::warn!(slot, "leaking a hotplug slot KVM may still map");
            std::mem::forget(region);
        }
    }

    /// Replaces the view with `update` applied to the current map. Only
    /// `update` can fail.
    fn publish<E>(
        &self,
        update: impl FnOnce(GuestMemoryMmap) -> Result<GuestMemoryMmap, E>,
    ) -> Result<(), E> {
        // The lock only orders writers; a writer that panicked left the view
        // whole, so a poisoned lock is still safe to use.
        let guard = self.view.lock().unwrap_or_else(PoisonError::into_inner);
        let current = GuestMemoryMmap::clone(&self.view.memory());
        guard.replace(update(current)?);
        Ok(())
    }
}

impl<V: Vm + ?Sized> Drop for HotplugMemory<V> {
    fn drop(&mut self) {
        for slot in self.slots.iter_mut() {
            if let Some(region) = slot.take()
                && self.vm.unmap_memory(&kvm_region(&region)).is_err()
            {
                // KVM may still map it; leaking beats freeing guest memory.
                std::mem::forget(region);
            }
        }
    }
}

fn slots_of(blocks: &Range<usize>) -> Range<usize> {
    blocks.start / BLOCKS_PER_SLOT..blocks.end.div_ceil(BLOCKS_PER_SLOT)
}

fn kvm_region(region: &GuestRegionMmap) -> MemoryRegion {
    MemoryRegion {
        guest_addr: region.start_addr().0,
        // vm-memory rejects a failed mmap, so a region pointer is never null.
        host_addr: NonNull::new(region.as_ptr()).expect("mmap returned a null mapping"),
        size: region.len() as usize,
    }
}

/// Returns `count` blocks starting at block `first` of `region` to the host.
fn discard(region: &GuestRegionMmap, first: usize, count: usize) -> io::Result<()> {
    let offset = first as u64 * BLOCK_SIZE;
    let len = count as u64 * BLOCK_SIZE;
    // SAFETY: the range lies inside the private anonymous mapping `region`
    // owns. The guest unplugged these blocks, so dropping their contents is
    // the requested effect; a later access faults in zero pages.
    let result = unsafe {
        libc::madvise(
            region.as_ptr().add(offset as usize).cast(),
            len as usize,
            libc::MADV_DONTNEED,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../tests/hotplug/mod.rs"]
mod tests;
