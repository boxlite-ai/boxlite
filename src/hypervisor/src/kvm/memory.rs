// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Transactional memory-slot bookkeeping, private to KVM.

use std::{io, ptr::NonNull};

use kvm_bindings::kvm_userspace_memory_region;

use crate::MemoryRegion;

/// KVM's limit on host pages in a single memory slot.
pub(super) const MAX_PAGES_PER_SLOT: u64 = (1 << 31) - 1;

#[derive(Debug)]
struct LogicalRegion {
    guest_addr: u64,
    size: usize,
    // Identity only, never dereferenced. Store the address rather than a
    // pointer so the slot table can be shared through KvmVm's mutex.
    host_addr: usize,
    slots: Vec<u32>,
}

#[derive(Debug)]
pub(super) struct MemorySlots {
    regions: Vec<Option<kvm_userspace_memory_region>>,
    logical: Vec<LogicalRegion>,
    page_size: usize,
}

impl MemorySlots {
    pub(super) fn new(limit: usize, page_size: usize) -> Self {
        Self {
            regions: vec![None; limit],
            logical: Vec::new(),
            page_size,
        }
    }

    pub(super) fn page_size(&self) -> usize {
        self.page_size
    }

    pub(super) fn map_chunks(
        &mut self,
        region: &MemoryRegion,
        max_pages: u64,
        mut install: impl FnMut(kvm_userspace_memory_region) -> io::Result<()>,
        mut remove: impl FnMut(kvm_userspace_memory_region) -> io::Result<()>,
    ) -> io::Result<()> {
        let chunks = self.chunks(region, max_pages)?;
        // An overlap in any chunk must reject the entire registration before any ioctl.
        chunks
            .clone()
            .try_for_each(|chunk| self.check_overlap(&chunk))?;
        let mut logical = LogicalRegion {
            guest_addr: region.guest_addr,
            size: region.size,
            host_addr: region.host_addr.as_ptr() as usize,
            slots: Vec::new(),
        };
        for chunk in chunks.clone() {
            match self.map(&chunk, &mut install) {
                Ok(slot) => logical.slots.push(slot),
                Err(error) => {
                    for previous in chunks.take(logical.slots.len()).rev() {
                        let _ = self.unmap(&previous, &mut remove);
                    }
                    logical
                        .slots
                        .retain(|&slot| self.regions[slot as usize].is_some());
                    if !logical.slots.is_empty() {
                        self.logical.push(logical);
                    }
                    return Err(error);
                }
            }
        }
        self.logical.push(logical);
        Ok(())
    }

    fn find_logical(&self, region: &MemoryRegion) -> Option<usize> {
        let host_addr = region.host_addr.as_ptr() as usize;
        self.logical.iter().position(|entry| {
            entry.guest_addr == region.guest_addr
                && entry.size == region.size
                && entry.host_addr == host_addr
        })
    }

    pub(super) fn unmap_chunks(
        &mut self,
        region: &MemoryRegion,
        mut remove: impl FnMut(kvm_userspace_memory_region) -> io::Result<()>,
    ) -> io::Result<()> {
        let Some(index) = self.find_logical(region) else {
            return Ok(());
        };
        // Allocation picks the first free slot, so the recorded slots ascend.
        for slot in self.logical[index].slots.clone().into_iter().rev() {
            self.remove_slot(slot, &mut remove)?;
            // Forget each deleted slot before returning an error on a later
            // one: a reused slot can be Some without belonging to this region.
            self.logical[index]
                .slots
                .retain(|&remaining| remaining != slot);
        }
        self.logical.remove(index);
        Ok(())
    }

    fn chunks(
        &self,
        region: &MemoryRegion,
        max_pages: u64,
    ) -> io::Result<impl DoubleEndedIterator<Item = MemoryRegion> + ExactSizeIterator + Clone + use<>>
    {
        if max_pages == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "KVM memory chunks must contain at least one page",
            ));
        }
        self.validate_range(region)?;
        let region = *region;
        let view_bytes = max_pages
            .saturating_mul(self.page_size() as u64)
            .min(region.size as u64) as usize;
        Ok((0..region.size.div_ceil(view_bytes)).map(move |index| {
            let offset = index * view_bytes;
            MemoryRegion {
                guest_addr: region.guest_addr + offset as u64,
                host_addr: NonNull::new(region.host_addr.as_ptr().wrapping_add(offset))
                    .expect("validated host range cannot wrap"),
                size: view_bytes.min(region.size - offset),
            }
        }))
    }

    fn check_overlap(&self, region: &MemoryRegion) -> io::Result<()> {
        let end = region.guest_addr + region.size as u64;
        // Half-open ranges let adjacent RAM regions meet without overlapping.
        // Validation makes both end-address additions safe from overflow.
        if self.regions.iter().flatten().any(|existing| {
            region.guest_addr < existing.guest_phys_addr + existing.memory_size
                && existing.guest_phys_addr < end
        }) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "guest memory overlaps an existing KVM slot",
            ));
        }
        Ok(())
    }

    fn map(
        &mut self,
        region: &MemoryRegion,
        install: impl FnOnce(kvm_userspace_memory_region) -> io::Result<()>,
    ) -> io::Result<u32> {
        self.validate(region)?;
        self.check_overlap(region)?;
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
        // A rejected ioctl must not consume a slot or leave a phantom mapping.
        install(mapping)?;
        self.regions[slot] = Some(mapping);
        Ok(mapping.slot)
    }

    fn unmap(
        &mut self,
        region: &MemoryRegion,
        remove: impl FnOnce(kvm_userspace_memory_region) -> io::Result<()>,
    ) -> io::Result<()> {
        // A guest address can be reused with different backing; reject requests
        // whose host pointer or length no longer identifies the current mapping.
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
        self.remove_slot(slot as u32, remove)
    }

    fn remove_slot(
        &mut self,
        slot: u32,
        remove: impl FnOnce(kvm_userspace_memory_region) -> io::Result<()>,
    ) -> io::Result<()> {
        // A zero-size ioctl deletes the slot. An ioctl error, including
        // ENOENT from a syscall filter, does not prove the slot is gone.
        remove(kvm_userspace_memory_region {
            slot,
            ..Default::default()
        })?;
        self.regions[slot as usize] = None;
        Ok(())
    }

    fn validate(&self, region: &MemoryRegion) -> io::Result<()> {
        self.validate_range(region)?;
        if region.size as u64 / self.page_size() as u64 > MAX_PAGES_PER_SLOT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("KVM memory slot exceeds the limit of {MAX_PAGES_PER_SLOT} pages"),
            ));
        }
        Ok(())
    }

    fn validate_range(&self, region: &MemoryRegion) -> io::Result<()> {
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
    fn splits_a_region_at_max_pages_and_keeps_addresses_contiguous() {
        let mut slots = MemorySlots::new(8, 4096);
        let ram = MemoryRegion {
            size: 5 * 4096,
            ..region(0x1_0000_0000)
        };
        let mut installed = Vec::new();
        slots
            .map_chunks(
                &ram,
                2,
                |mapping| {
                    installed.push(mapping);
                    Ok(())
                },
                |_| unreachable!(),
            )
            .unwrap();

        assert_eq!(installed.len(), 3);
        let mut offset = 0;
        for (slot, (mapping, size)) in installed.iter().zip([8192, 8192, 4096]).enumerate() {
            assert_eq!(mapping.slot, slot as u32);
            assert_eq!(mapping.guest_phys_addr, ram.guest_addr + offset);
            assert_eq!(
                mapping.userspace_addr,
                ram.host_addr.as_ptr() as u64 + offset
            );
            assert_eq!(mapping.memory_size, size);
            offset += size;
        }
        assert_eq!(offset, ram.size as u64);
    }

    #[test]
    fn splits_an_exact_multiple_without_an_empty_tail() {
        let mut slots = MemorySlots::new(8, 4096);
        let ram = MemoryRegion {
            size: 4 * 4096,
            ..region(0)
        };
        assert_eq!(
            slots
                .map_chunks(&ram, 0, |_| unreachable!(), |_| unreachable!())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        let mut sizes = Vec::new();
        slots
            .map_chunks(
                &ram,
                2,
                |mapping| {
                    sizes.push(mapping.memory_size);
                    Ok(())
                },
                |_| unreachable!(),
            )
            .unwrap();
        assert_eq!(sizes, [8192, 8192]);
    }

    #[test]
    fn rolls_back_installed_views_when_a_later_view_fails() {
        let mut slots = MemorySlots::new(3, 4096);
        let ram = MemoryRegion {
            size: 3 * 4096,
            ..region(0)
        };
        let mut installed = Vec::new();
        let mut removed = Vec::new();
        let error = slots
            .map_chunks(
                &ram,
                1,
                |mapping| {
                    installed.push(mapping.slot);
                    if installed.len() == 3 {
                        Err(io::Error::from_raw_os_error(libc::EIO))
                    } else {
                        Ok(())
                    }
                },
                |mapping| {
                    assert_eq!(mapping.memory_size, 0);
                    removed.push(mapping.slot);
                    if mapping.slot == 1 {
                        Err(io::Error::from_raw_os_error(libc::EBUSY))
                    } else {
                        Ok(())
                    }
                },
            )
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EIO));
        assert_eq!(installed, [0, 1, 2]);
        assert_eq!(removed, [1, 0]);
        assert!(slots.regions[0].is_none());
        assert!(slots.regions[1].is_some());
        assert!(slots.regions[2].is_none());
        assert_eq!(
            slots
                .map_chunks(&ram, 1, |_| unreachable!(), |_| unreachable!())
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );

        removed.clear();
        slots
            .unmap_chunks(&ram, |mapping| {
                assert_eq!(mapping.memory_size, 0);
                removed.push(mapping.slot);
                Ok(())
            })
            .unwrap();
        assert_eq!(removed, [1]);
        assert!(slots.regions.iter().all(Option::is_none));
        slots
            .map_chunks(&ram, 1, |_| Ok(()), |_| unreachable!())
            .unwrap();
    }

    #[test]
    fn a_fully_rolled_back_region_can_be_remapped_without_unmap() {
        let mut slots = MemorySlots::new(3, 4096);
        let ram = MemoryRegion {
            size: 3 * 4096,
            ..region(0)
        };
        let mut installed = Vec::new();
        let mut removed = Vec::new();
        let error = slots
            .map_chunks(
                &ram,
                1,
                |mapping| {
                    installed.push(mapping.slot);
                    if mapping.slot == 2 {
                        Err(io::Error::from_raw_os_error(libc::EIO))
                    } else {
                        Ok(())
                    }
                },
                |mapping| {
                    assert_eq!(mapping.memory_size, 0);
                    removed.push(mapping.slot);
                    Ok(())
                },
            )
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EIO));
        assert_eq!(installed, [0, 1, 2]);
        assert_eq!(removed, [1, 0]);
        assert_eq!(slots.find_logical(&ram), None);
        assert!(slots.regions.iter().all(Option::is_none));
        slots
            .map_chunks(&ram, 1, |_| Ok(()), |_| unreachable!())
            .unwrap();
    }

    #[test]
    fn unmap_chunks_does_not_issue_ioctls_on_a_second_unmap() {
        let mut slots = MemorySlots::new(3, 4096);
        let ram = MemoryRegion {
            size: 3 * 4096,
            ..region(0)
        };
        slots
            .map_chunks(&ram, 1, |_| Ok(()), |_| unreachable!())
            .unwrap();
        let mut removed = Vec::new();
        slots
            .unmap_chunks(&ram, |mapping| {
                assert_eq!(mapping.memory_size, 0);
                removed.push(mapping.slot);
                Ok(())
            })
            .unwrap();
        assert_eq!(removed, [2, 1, 0]);
        assert!(slots.regions.iter().all(Option::is_none));
        slots
            .unmap_chunks(&ram, |_| panic!("already removed region reached remove"))
            .unwrap();
    }

    #[test]
    fn unmap_chunks_keeps_slots_when_the_ioctl_reports_not_found() {
        let mut slots = MemorySlots::new(2, 4096);
        let ram = MemoryRegion {
            size: 8192,
            ..region(0)
        };
        slots
            .map_chunks(&ram, 1, |_| Ok(()), |_| unreachable!())
            .unwrap();
        let error = slots
            .unmap_chunks(&ram, |mapping| {
                assert_eq!(mapping.slot, 1);
                Err(io::ErrorKind::NotFound.into())
            })
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(slots.regions.iter().all(Option::is_some));

        let mut removed = Vec::new();
        slots
            .unmap_chunks(&ram, |mapping| {
                removed.push(mapping.slot);
                Ok(())
            })
            .unwrap();
        assert_eq!(removed, [1, 0]);
        assert!(slots.regions.iter().all(Option::is_none));
    }

    #[test]
    fn unmap_chunks_refuses_a_region_that_is_not_the_registered_one() {
        let mut slots = MemorySlots::new(2, 4096);
        let first_chunk = region(0);
        let ram = MemoryRegion {
            size: 8192,
            ..first_chunk
        };
        slots
            .map_chunks(&ram, 1, |_| Ok(()), |_| unreachable!())
            .unwrap();
        let different_backing = MemoryRegion {
            host_addr: NonNull::new(0x20000 as *mut u8).unwrap(),
            ..ram
        };
        for other in [first_chunk, different_backing] {
            slots
                .unmap_chunks(&other, |_| panic!("unmatched region reached remove"))
                .unwrap();
            assert!(slots.regions.iter().all(Option::is_some));
        }
    }

    #[test]
    fn a_reused_slot_is_not_removed_by_a_stale_retry() {
        let mut slots = MemorySlots::new(3, 4096);
        let a = MemoryRegion {
            size: 8192,
            ..region(0)
        };
        let b = MemoryRegion {
            host_addr: NonNull::new(0x20000 as *mut u8).unwrap(),
            ..region(8192)
        };
        slots
            .map_chunks(&a, 1, |_| Ok(()), |_| unreachable!())
            .unwrap();
        slots
            .map_chunks(
                &b,
                1,
                |mapping| {
                    assert_eq!(mapping.slot, 2);
                    Ok(())
                },
                |_| unreachable!(),
            )
            .unwrap();
        let mut removed = Vec::new();
        let error = slots
            .unmap_chunks(&a, |mapping| {
                removed.push(mapping.slot);
                if mapping.slot == 0 {
                    Err(io::Error::from_raw_os_error(libc::EBUSY))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EBUSY));
        assert_eq!(removed, [1, 0]);

        slots.unmap_chunks(&b, |_| Ok(())).unwrap();
        slots
            .map_chunks(
                &b,
                1,
                |mapping| {
                    assert_eq!(mapping.slot, 1);
                    Ok(())
                },
                |_| unreachable!(),
            )
            .unwrap();
        removed.clear();
        slots
            .unmap_chunks(&a, |mapping| {
                removed.push(mapping.slot);
                Ok(())
            })
            .unwrap();
        assert_eq!(removed, [0]);
        assert!(slots.regions[0].is_none());
        assert_eq!(slots.regions[1].unwrap().guest_phys_addr, b.guest_addr);
        assert!(slots.regions[2].is_none());
    }

    #[test]
    fn unmap_chunks_stops_at_the_first_real_failure() {
        let mut slots = MemorySlots::new(3, 4096);
        let ram = MemoryRegion {
            size: 3 * 4096,
            ..region(0)
        };
        slots
            .map_chunks(&ram, 1, |_| Ok(()), |_| unreachable!())
            .unwrap();
        let mut removed = Vec::new();
        let error = slots
            .unmap_chunks(&ram, |mapping| {
                removed.push(mapping.slot);
                if mapping.slot == 1 {
                    Err(io::Error::from_raw_os_error(libc::EBUSY))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EBUSY));
        assert_eq!(removed, [2, 1]);

        removed.clear();
        slots
            .unmap_chunks(&ram, |mapping| {
                removed.push(mapping.slot);
                Ok(())
            })
            .unwrap();
        assert_eq!(removed, [1, 0]);
    }

    #[test]
    fn accepts_exactly_the_page_limit_and_refuses_one_more() {
        let mut slots = MemorySlots::new(4, 4096);
        let limit = MemoryRegion {
            size: (MAX_PAGES_PER_SLOT * 4096) as usize,
            ..region(0)
        };
        slots
            .map(&limit, |mapping| {
                assert_eq!(mapping.memory_size, limit.size as u64);
                Ok(())
            })
            .unwrap();
        let oversized = MemoryRegion {
            size: limit.size + 4096,
            ..limit
        };
        let error = slots.map(&oversized, |_| unreachable!()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains(&MAX_PAGES_PER_SLOT.to_string()));
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
    fn preflight_overlap_rejects_the_whole_region_before_any_install() {
        let mut slots = MemorySlots::new(2, 4096);
        slots
            .map_chunks(&region(0x1000), 1, |_| Ok(()), |_| unreachable!())
            .unwrap();
        let before = slots.regions.clone();
        let ram = MemoryRegion {
            size: 0x2000,
            ..region(0)
        };
        let error = slots
            .map_chunks(
                &ram,
                1,
                |_| panic!("overlapping region reached install"),
                |_| panic!("overlapping region reached remove"),
            )
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            error.to_string(),
            "guest memory overlaps an existing KVM slot"
        );
        assert_eq!(slots.regions, before);
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
