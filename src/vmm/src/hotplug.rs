// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Hotplug memory above the boot RAM.
//!
//! [`HotplugMemory`] owns a guest-physical window that a virtio-mem driver
//! plugs and unplugs in [`BLOCK_SIZE`] blocks. The VMM backs and registers it
//! in [`SLOT_SIZE`] slots: a slot gains its own anonymous mapping and KVM
//! registration when its first block is plugged, and loses both when its last
//! block is unplugged and unregistration succeeds. An unplugged block inside a
//! slot that still contains plugged blocks is
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
use vm_memory::{
    GuestAddress, GuestAddressSpace, GuestMemoryBackend, GuestMemoryRegion, GuestRegionMmap,
};

use crate::memory::{GuestMemoryMmap, GuestMemoryView};

const MIB: u64 = 1 << 20;

/// The virtio-mem device block: the unit the guest plugs and unplugs.
pub(crate) const BLOCK_SIZE: u64 = 2 * MIB;

/// The unit of host mapping and KVM registration; also the capacity step.
pub(crate) const SLOT_SIZE: u64 = 128 * MIB;

const BLOCKS_PER_SLOT: usize = (SLOT_SIZE / BLOCK_SIZE) as usize;

/// The lowest window address, immediately above the x86_64 MMIO hole.
const HOTPLUG_MIN_ADDR: u64 = 1 << 32;
/// Exclusive pluggable limit of the bundled guest's four-level direct map.
const GUEST_PLUGGABLE_END: u64 = 1 << 46;

/// An x86_64 virtio-mem window checked against boot RAM, Linux and KVM.
#[derive(Clone, Copy, Debug)]
pub(crate) struct HotplugWindow {
    base: u64,
    slots: usize,
}

impl HotplugWindow {
    pub(crate) fn plan(
        boot_ranges: &[(GuestAddress, usize)],
        capacity_mib: u32,
        physical_end: u64,
        available_slots: usize,
    ) -> io::Result<Self> {
        let overflow = || io::Error::new(io::ErrorKind::InvalidInput, "hotplug address overflow");
        let boot_end = boot_ranges.iter().try_fold(0, |highest, (start, size)| {
            let end = start.0.checked_add(*size as u64).ok_or_else(overflow)?;
            Ok::<_, io::Error>(highest.max(end))
        })?;
        // The bundled Linux x86_64 guest uses probe_memory_block_size() with
        // the hypervisor bit set. At 64 GiB it scales up to a divisor of boot_end.
        let alignment = if boot_end < 1 << 36 {
            SLOT_SIZE
        } else {
            (1u64 << boot_end.trailing_zeros().min(31)).max(SLOT_SIZE)
        };
        let size = u64::from(capacity_mib) * MIB;
        if size == 0 || !size.is_multiple_of(alignment) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "hotplug capacity must be a positive multiple of {} MiB",
                    alignment / MIB
                ),
            ));
        }
        let base = boot_end
            .max(HOTPLUG_MIN_ADDR)
            .checked_next_multiple_of(alignment)
            .ok_or_else(overflow)?;
        let end = base.checked_add(size).ok_or_else(overflow)?;
        if end > physical_end.min(GUEST_PLUGGABLE_END) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "hotplug window exceeds the guest physical address limit",
            ));
        }
        let slots = (size / SLOT_SIZE) as usize;
        if slots > available_slots {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "hotplug capacity exceeds the available KVM memory slots",
            ));
        }
        Ok(Self { base, slots })
    }
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
    /// Nothing is mapped or registered in the window until a plug.
    pub(crate) fn new(vm: Arc<V>, view: GuestMemoryView, window: HotplugWindow) -> Self {
        Self {
            vm,
            view,
            base: window.base,
            slots: vec![None; window.slots],
            plugged: vec![false; window.slots * BLOCKS_PER_SLOT],
        }
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

    pub(crate) fn retained_empty_mapped_bytes(&self) -> u64 {
        self.slots
            .iter()
            .zip(self.plugged.as_chunks::<BLOCKS_PER_SLOT>().0)
            .filter(|(mapping, blocks)| mapping.is_some() && !blocks.iter().any(|&plugged| plugged))
            .count() as u64
            * SLOT_SIZE
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
        let slots = slots_of(&blocks);
        // A failed rollback may leave an unpublished but registered slot.
        // Reusing it as a published slot would expose RAM through an incomplete view.
        let touches_unpublished_slot = {
            let view = self.view.memory();
            slots
                .clone()
                .filter_map(|slot| self.slots[slot].as_ref())
                .any(|region| !view.address_in_range(region.start_addr()))
        };
        if touches_unpublished_slot {
            return Err(io::Error::other(
                "a failed hotplug rollback retained an unpublished KVM mapping",
            ));
        }
        let mut added = Vec::new();
        for slot in slots {
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

    /// Unregisters an unpublished slot, retaining ownership if KVM still maps it.
    fn release(&mut self, slot: usize, region: Arc<GuestRegionMmap>) {
        if self.vm.unmap_memory(&kvm_region(&region)).is_err() {
            tracing::warn!(slot, "retaining a hotplug slot KVM may still map");
            self.slots[slot] = Some(region);
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
