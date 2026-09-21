// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Transactional memory-slot bookkeeping, private to KVM.

use std::io;

use kvm_bindings::kvm_userspace_memory_region;

use crate::MemoryRegion;

#[derive(Debug)]
pub(super) struct MemorySlots {
    regions: Vec<Option<kvm_userspace_memory_region>>,
    page_size: usize,
}

impl MemorySlots {
    pub(super) fn new(limit: usize, page_size: usize) -> Self {
        Self {
            regions: vec![None; limit],
            page_size,
        }
    }

    pub(super) fn map(
        &mut self,
        region: &MemoryRegion,
        install: impl FnOnce(kvm_userspace_memory_region) -> io::Result<()>,
    ) -> io::Result<()> {
        self.validate(region)?;
        let end = region.guest_addr + region.size as u64;
        if self.regions.iter().flatten().any(|existing| {
            region.guest_addr < existing.guest_phys_addr + existing.memory_size
                && existing.guest_phys_addr < end
        }) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "guest memory overlaps an existing KVM slot",
            ));
        }
        let slot = self
            .regions
            .iter()
            .position(Option::is_none)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::OutOfMemory, "no free KVM memory slots")
            })?;
        let mapping = kvm_userspace_memory_region {
            slot: slot as u32,
            flags: 0,
            guest_phys_addr: region.guest_addr,
            memory_size: region.size as u64,
            userspace_addr: region.host_addr.as_ptr() as u64,
        };
        install(mapping)?;
        self.regions[slot] = Some(mapping);
        Ok(())
    }

    pub(super) fn unmap(
        &mut self,
        region: &MemoryRegion,
        remove: impl FnOnce(kvm_userspace_memory_region) -> io::Result<()>,
    ) -> io::Result<()> {
        let slot = self
            .regions
            .iter()
            .position(|entry| {
                entry.is_some_and(|mapping| {
                    mapping.guest_phys_addr == region.guest_addr
                        && mapping.memory_size == region.size as u64
                        && mapping.userspace_addr == region.host_addr.as_ptr() as u64
                })
            })
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "KVM memory region is not mapped")
            })?;
        remove(kvm_userspace_memory_region {
            slot: slot as u32,
            ..Default::default()
        })?;
        self.regions[slot] = None;
        Ok(())
    }

    fn validate(&self, region: &MemoryRegion) -> io::Result<()> {
        let host_addr = region.host_addr.as_ptr() as usize;
        if region.size == 0
            || !region.size.is_multiple_of(self.page_size)
            || !host_addr.is_multiple_of(self.page_size)
            || !region.guest_addr.is_multiple_of(self.page_size as u64)
            || host_addr.checked_add(region.size).is_none()
            || region.guest_addr.checked_add(region.size as u64).is_none()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "KVM memory ranges must be nonempty, page-aligned and not overflow",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::ptr::NonNull;

    use super::*;

    // The fake ioctl never dereferences these addresses.
    fn region(guest_addr: u64) -> MemoryRegion {
        MemoryRegion {
            guest_addr,
            host_addr: NonNull::new(0x10000 as *mut u8).unwrap(),
            size: 4096,
        }
    }

    #[test]
    fn failed_install_does_not_consume_a_slot() {
        let mut slots = MemorySlots::new(1, 4096);
        let error = slots
            .map(&region(0), |_| Err(io::Error::from_raw_os_error(libc::EIO)))
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EIO));
        slots
            .map(&region(0), |mapping| {
                assert_eq!(mapping.slot, 0);
                assert_eq!(mapping.memory_size, 4096);
                assert_eq!(mapping.userspace_addr, 0x10000);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            slots
                .map(&region(4096), |_| unreachable!())
                .unwrap_err()
                .kind(),
            io::ErrorKind::OutOfMemory
        );
    }

    #[test]
    fn failed_removal_retains_mapping_and_successful_removal_reuses_slot() {
        let mut slots = MemorySlots::new(1, 4096);
        slots.map(&region(0), |_| Ok(())).unwrap();
        slots
            .unmap(&region(0), |_| {
                Err(io::Error::from_raw_os_error(libc::EBUSY))
            })
            .unwrap_err();
        assert_eq!(
            slots
                .map(&region(0), |_| unreachable!())
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        slots
            .unmap(&region(0), |mapping| {
                assert_eq!(mapping.slot, 0);
                assert_eq!(mapping.memory_size, 0);
                Ok(())
            })
            .unwrap();
        slots.map(&region(4096), |_| Ok(())).unwrap();
    }

    #[test]
    fn unmap_requires_the_original_backing_address_and_size() {
        let mut slots = MemorySlots::new(1, 4096);
        slots.map(&region(0), |_| Ok(())).unwrap();
        let mut changed = region(0);
        changed.host_addr = NonNull::new(0x20000 as *mut u8).unwrap();
        for incorrect in [
            changed,
            MemoryRegion {
                size: 8192,
                ..region(0)
            },
        ] {
            assert_eq!(
                slots
                    .unmap(&incorrect, |_| unreachable!())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::NotFound
            );
        }
        slots.unmap(&region(0), |_| Ok(())).unwrap();
    }

    #[test]
    fn invalid_ranges_and_overlaps_never_reach_kvm() {
        let mut slots = MemorySlots::new(3, 4096);
        for invalid in [
            region(1),
            region(u64::MAX - 4095),
            MemoryRegion {
                size: 0,
                ..region(0)
            },
            MemoryRegion {
                size: 4097,
                ..region(0)
            },
            MemoryRegion {
                host_addr: NonNull::new(0x10001 as *mut u8).unwrap(),
                ..region(0)
            },
            MemoryRegion {
                host_addr: NonNull::new((usize::MAX - 4095) as *mut u8).unwrap(),
                ..region(0)
            },
        ] {
            assert_eq!(
                slots.map(&invalid, |_| unreachable!()).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
        slots
            .map(
                &MemoryRegion {
                    size: 8192,
                    ..region(4096)
                },
                |_| Ok(()),
            )
            .unwrap();
        assert_eq!(
            slots
                .map(&region(8192), |_| unreachable!())
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        slots.map(&region(0), |_| Ok(())).unwrap();
        slots.map(&region(12288), |_| Ok(())).unwrap();
    }
}
