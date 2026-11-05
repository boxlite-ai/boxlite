// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest RAM layout, allocation and the registration lifetime rules, driven
//! through the mock backend.

use std::{error::Error as _, sync::Arc};

use boxlite_hypervisor::Error as HypervisorError;
use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend};

use super::{GuestRam, MAX_MEMORY_MIB, RAM_START, ram_ranges};
use crate::{
    error::Error,
    mock_vm::{Call, MockVm},
};

const MIB: usize = 1 << 20;

/// Two regions far apart, so ascending and descending orders differ and the
/// second registration can fail on its own; the addresses are never run.
fn two_regions() -> GuestRam {
    GuestRam::new(&[(GuestAddress(0), MIB), (GuestAddress(1 << 32), MIB)]).unwrap()
}

fn expected_calls(ram: &GuestRam) -> Vec<(Call, Call)> {
    ram.regions()
        .map(|region| (Call::map(&region), Call::unmap(&region)))
        .collect()
}

#[test]
fn ram_ranges_place_one_mib_aligned_region_at_the_architecture_start() {
    assert_eq!(ram_ranges(1), [(GuestAddress(RAM_START), MIB)]);
    let largest = ram_ranges(MAX_MEMORY_MIB);
    assert_eq!(largest, [(GuestAddress(RAM_START), 3072 * MIB)]);
    for (start, size) in largest {
        assert_eq!(start.0 % MIB as u64, 0);
        assert_eq!(size % MIB, 0);
    }
    #[cfg(target_arch = "x86_64")]
    assert_eq!(RAM_START + (3072 * MIB) as u64, super::MMIO_HOLE_START);
}

#[test]
fn allocated_ram_is_zeroed_and_mirrors_its_ranges() {
    let ram = GuestRam::new(&ram_ranges(2)).unwrap();
    let regions: Vec<_> = ram.regions().collect();
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].guest_addr, RAM_START);
    assert_eq!(regions[0].size, 2 * MIB);
    let host = ram
        .memory()
        .get_host_address(GuestAddress(RAM_START))
        .unwrap();
    assert_eq!(regions[0].host_addr.as_ptr(), host);
    assert_eq!(host as usize % 4096, 0, "mmap returns page-aligned memory");

    let last = GuestAddress(RAM_START + 2 * MIB as u64 - 1);
    assert_eq!(ram.memory().read_obj::<u8>(last).unwrap(), 0);
    ram.memory().write_obj(0x4bu8, last).unwrap();
    assert_eq!(ram.memory().read_obj::<u8>(last).unwrap(), 0x4b);
}

#[test]
fn two_regions_are_reported_in_ascending_order() {
    let starts: Vec<u64> = two_regions()
        .regions()
        .map(|region| region.guest_addr)
        .collect();
    assert_eq!(starts, [0, 1 << 32]);
}

#[test]
fn maps_ascending_and_unmaps_descending_with_the_backing_addresses() {
    let mut ram = two_regions();
    let vm = MockVm::new();
    let [(map0, unmap0), (map1, unmap1)] = expected_calls(&ram)[..] else {
        panic!("two regions")
    };

    ram.map(&vm).unwrap();
    assert_eq!(vm.calls(), [map0, map1]);
    ram.unmap(&vm).unwrap();
    assert_eq!(vm.calls(), [map0, map1, unmap1, unmap0]);
}

#[test]
fn failed_second_map_unmaps_the_first_and_leaves_ram_remappable() {
    let mut ram = two_regions();
    let vm = MockVm::failing_at(&[1]);
    let [(map0, unmap0), (map1, _)] = expected_calls(&ram)[..] else {
        panic!("two regions")
    };

    let error = ram.map(&vm).unwrap_err();
    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::MapMemory { guest_addr, size, .. })
            if guest_addr == 1 << 32 && size == MIB
    ));
    assert_eq!(vm.calls(), [map0, map1, unmap0]);

    let retry = MockVm::new();
    ram.map(&retry).unwrap();
    assert_eq!(retry.calls(), [map0, map1]);
    ram.unmap(&retry).unwrap();
}

#[test]
fn failed_rollback_keeps_the_backing_alive() {
    let mut ram = two_regions();
    let vm = MockVm::failing_at(&[1, 2]);
    let weak = Arc::downgrade(ram.memory());

    let error = ram.map(&vm).unwrap_err();
    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::MapMemory { .. })
    ));
    assert_eq!(vm.calls().len(), 3, "map, failed map, failed rollback");
    assert_eq!(ram.mapped, 1);

    drop(ram);
    assert!(
        weak.upgrade().is_some(),
        "a registered region keeps its backing"
    );
}

#[test]
fn failed_unmap_keeps_state_and_retry_unmaps_only_the_remainder() {
    let mut ram = two_regions();
    let vm = MockVm::failing_at(&[3]);
    let [(map0, unmap0), (map1, unmap1)] = expected_calls(&ram)[..] else {
        panic!("two regions")
    };
    let weak = Arc::downgrade(ram.memory());
    ram.map(&vm).unwrap();

    let error = ram.unmap(&vm).unwrap_err();
    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::UnmapMemory { guest_addr: 0, size, .. }) if size == MIB
    ));
    assert_eq!(ram.mapped, 1);
    assert_eq!(vm.calls(), [map0, map1, unmap1, unmap0]);

    ram.unmap(&vm).unwrap();
    assert_eq!(ram.mapped, 0);
    assert_eq!(vm.calls(), [map0, map1, unmap1, unmap0, unmap0]);
    drop(ram);
    assert!(
        weak.upgrade().is_none(),
        "an unmapped RAM releases its backing"
    );
}

#[test]
fn drop_without_unmap_leaks_the_backing() {
    let mut ram = two_regions();
    let weak = Arc::downgrade(ram.memory());
    ram.map(&MockVm::new()).unwrap();

    drop(ram);
    assert!(weak.upgrade().is_some());
}

#[test]
fn unmap_without_registrations_records_nothing() {
    let mut ram = two_regions();
    let vm = MockVm::new();
    ram.unmap(&vm).unwrap();
    assert!(vm.calls().is_empty());
}

#[test]
fn allocation_failure_keeps_the_cause() {
    let error = GuestRam::new(&[(GuestAddress(u64::MAX - 0xfff), 0x1000)]).unwrap_err();
    assert!(matches!(error, Error::AllocateMemory { bytes: 0x1000, .. }));
    assert_eq!(
        error.to_string(),
        "failed to allocate 4096 bytes of guest RAM"
    );
    assert!(
        error.source().is_some(),
        "vm-memory's reason stays reachable"
    );

    let error = GuestRam::new(&[(GuestAddress(RAM_START), 0)]).unwrap_err();
    assert!(matches!(error, Error::AllocateMemory { bytes: 0, .. }));
}

#[test]
fn guest_ram_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<GuestRam>();
}

#[test]
fn balloon_reclaim_alignment_is_inward_for_4_16_and_64_kib_hosts() {
    for page in [4096, 16384, 65536] {
        assert_eq!(super::interior_pages(0, page * 2, page), (0, page * 2));
        assert_eq!(
            super::interior_pages(1, page * 3 - 2, page),
            (page - 1, page)
        );
        assert_eq!(super::interior_pages(page - 1, 2, page), (1, 0));
        assert_eq!(super::interior_pages(1, page - 1, page), (page - 1, 0));
        assert_eq!(super::interior_pages(1, 1, page), (1, 0));
        // A guest 4 KiB report on a 16/64 KiB host must not touch its
        // neighbours merely to make a host page fit.
        if page > 4096 {
            assert_eq!(super::interior_pages(4096, 4096, page), (4096, 0));
        }
        let (offset, len) = super::interior_pages(usize::MAX - 2, 2, page);
        assert!(offset <= 2);
        assert_eq!(len, 0);
    }
}

#[test]
fn balloon_reclaim_validates_the_original_whole_region_not_just_its_start() {
    let memory = super::GuestMemoryMmap::from_ranges(&[
        (GuestAddress(0), 0x10000),
        (GuestAddress(0x10000), 0x10000),
        (GuestAddress(0x30000), 0x10000),
    ])
    .unwrap();
    let page = super::host_page_size().unwrap();
    for (address, len) in [
        (0, 0),
        (0xffff, 2),
        (0x1ffff, 0x10002),
        (0x20000, 1),
        (0x3ffff, 2),
        (u64::MAX, 2),
    ] {
        assert!(
            super::ReclaimRange::new(&memory, GuestAddress(address), len, page).is_err(),
            "address={address:#x} len={len}"
        );
    }
    assert!(super::ReclaimRange::new(&memory, GuestAddress(0xffff), 1, page).is_ok());
    assert!(super::ReclaimRange::new(&memory, GuestAddress(0), 1, 0).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn balloon_reclaim_uses_host_addresses_and_preserves_partial_page_neighbours() {
    let host_page = super::host_page_size().unwrap();
    for page in [4096, 16384, 65536] {
        if page < host_page || page % host_page != 0 {
            continue;
        }
        let memory =
            super::GuestMemoryMmap::from_ranges(&[(GuestAddress(0x1234), page * 8)]).unwrap();
        let region = memory.iter().next().unwrap();
        let host_start = region.as_ptr() as usize;
        // Choose a host-aligned interior independently of the unaligned GPA.
        let offset = (page - host_start % page) % page;
        let aligned = offset + page;
        let report_start = aligned + 1;
        let report_len = page * 3 - 2;
        for byte in 0..page * 8 {
            memory
                .write_obj(0x5au8, GuestAddress(0x1234 + byte as u64))
                .unwrap();
        }
        super::ReclaimRange::new(
            &memory,
            GuestAddress(0x1234 + report_start as u64),
            report_len,
            page,
        )
        .unwrap()
        .reclaim(super::ReclaimPolicy::Immediate)
        .unwrap();
        for offset in [
            aligned,
            aligned + page - 1,
            aligned + page * 2,
            aligned + page * 3 - 1,
        ] {
            assert_eq!(
                memory
                    .read_obj::<u8>(GuestAddress(0x1234 + offset as u64))
                    .unwrap(),
                0x5a
            );
        }
        for offset in [aligned + page, aligned + page * 2 - 1] {
            let address = GuestAddress(0x1234 + offset as u64);
            assert_eq!(memory.read_obj::<u8>(address).unwrap(), 0);
            memory.write_obj(0x77u8, address).unwrap();
            assert_eq!(memory.read_obj::<u8>(address).unwrap(), 0x77);
        }
    }
}

#[test]
fn reporting_rejects_shared_and_non_owned_backing() {
    use vm_memory::{GuestRegionMmap, MmapRegion, mmap::MmapRegionBuilder};
    let page = super::host_page_size().unwrap();
    let shared = MmapRegionBuilder::<()>::new(page)
        .with_mmap_prot(libc::PROT_READ | libc::PROT_WRITE)
        .with_mmap_flags(libc::MAP_ANONYMOUS | libc::MAP_SHARED)
        .build()
        .unwrap();
    let shared = super::GuestMemoryMmap::from_regions(vec![
        GuestRegionMmap::new(shared, GuestAddress(0)).unwrap(),
    ])
    .unwrap();
    assert!(super::ReclaimRange::new(&shared, GuestAddress(0), page, page).is_err());
    let owner = MmapRegion::<()>::new(page).unwrap();
    // SAFETY: owner remains alive until after the non-owning view is dropped;
    // no content references are created and the raw view never unmaps it.
    let raw = unsafe {
        MmapRegion::<()>::build_raw(
            owner.as_ptr(),
            page,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_ANONYMOUS | libc::MAP_PRIVATE,
        )
    }
    .unwrap();
    let raw = super::GuestMemoryMmap::from_regions(vec![
        GuestRegionMmap::new(raw, GuestAddress(0)).unwrap(),
    ])
    .unwrap();
    assert!(super::ReclaimRange::new(&raw, GuestAddress(0), page, page).is_err());
}
