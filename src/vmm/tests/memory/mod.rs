// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest RAM layout, allocation and the registration lifetime rules, driven
//! through the mock backend.

use std::{error::Error as _, io, sync::Arc};

use boxlite_hypervisor::{Error as HypervisorError, Vm};
use vm_memory::{Bytes, GuestAddress, GuestAddressSpace, GuestMemoryBackend};

use super::{ARM64_LAYOUT, GuestRam, RAM_START, X86_LAYOUT, check_ram_end, ram_ranges};
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

/// The mock does not install slices. Seed the second range before injecting
/// the map failure to model slices left registered by a real backend.
fn seed_second_registration(ram: &GuestRam, vm: &MockVm) {
    let second = ram.regions().nth(1).unwrap();
    // SAFETY: GuestRam owns the backing and the mock only records its address.
    unsafe { vm.map_memory(&second) }.unwrap();
}

#[test]
fn ram_ranges_place_one_mib_aligned_region_at_the_architecture_start() {
    assert_eq!(ram_ranges(1), [(GuestAddress(RAM_START), MIB)]);
    assert_eq!(RAM_START % MIB as u64, 0);
}

// Each case lists the requested MiB and the expected (start GPA, length in MiB).
const X86_LAYOUT_CASES: &[(u32, &[(u64, u32)])] = &[
    (0, &[]),
    (1, &[(0, 1)]),
    (3072, &[(0, 3072)]),
    (3073, &[(0, 3072), (0x1_0000_0000, 1)]),
    (4096, &[(0, 3072), (0x1_0000_0000, 1024)]),
    (4097, &[(0, 3072), (0x1_0000_0000, 1025)]),
    (6144, &[(0, 3072), (0x1_0000_0000, 3072)]),
    (u32::MAX, &[(0, 3072), (0x1_0000_0000, u32::MAX - 3072)]),
];

fn assert_layout_ranges(
    memory_mib: u32,
    actual: &[(GuestAddress, usize)],
    expected: &[(u64, u32)],
) {
    assert_eq!(actual.len(), expected.len(), "memory_mib={memory_mib}");
    let mut total = 0;
    for (&(start, len), &(expected_start, expected_len_mib)) in actual.iter().zip(expected) {
        let len = u64::try_from(len).unwrap();
        assert_eq!(start.0, expected_start, "memory_mib={memory_mib}");
        assert_eq!(
            len,
            u64::from(expected_len_mib) << 20,
            "memory_mib={memory_mib}"
        );
        assert_ne!(len, 0, "memory_mib={memory_mib}");
        assert_eq!(start.0 % 4096, 0, "memory_mib={memory_mib}");
        assert_eq!(len % 4096, 0, "memory_mib={memory_mib}");
        total += len;
    }
    assert_eq!(
        total,
        u64::from(memory_mib) << 20,
        "memory_mib={memory_mib}"
    );
}

#[test]
fn x86_ram_layout_splits_at_the_mmio_hole() {
    for &(memory_mib, expected) in X86_LAYOUT_CASES {
        let actual = X86_LAYOUT.ranges(u64::from(memory_mib) << 20).unwrap();
        assert_layout_ranges(memory_mib, &actual, expected);
        if memory_mib == 3072 {
            // The low RAM band is full but does not spill into high RAM.
            let [(start, len)] = actual[..] else {
                panic!("one low RAM band");
            };
            assert_eq!(start.0 + len as u64, super::MMIO_HOLE_START);
        }
    }
}

#[test]
fn arm64_ram_layout_keeps_one_nonempty_range() {
    for &(memory_mib, _) in X86_LAYOUT_CASES {
        let actual = ARM64_LAYOUT.ranges(u64::from(memory_mib) << 20).unwrap();
        let expected = [(0x8000_0000, memory_mib)];
        let expected = if memory_mib == 0 {
            &[][..]
        } else {
            &expected[..]
        };
        assert_layout_ranges(memory_mib, &actual, expected);
    }
}

#[test]
fn address_limit_uses_end_of_each_actual_ram_band() {
    for (layout, limit_end, fits, exceeds, rejected_end) in [
        (X86_LAYOUT, 1 << 36, 64512, 64513, 0x10_0010_0000),
        (ARM64_LAYOUT, 1 << 36, 63488, 63489, 0x10_0010_0000),
        (X86_LAYOUT, 1 << 32, 3072, 3073, 0x1_0010_0000),
    ] {
        let ranges = |memory_mib| layout.ranges(u64::from(memory_mib) << 20).unwrap();
        check_ram_end(fits, &ranges(fits), limit_end, "test GPA").unwrap();
        let error = check_ram_end(exceeds, &ranges(exceeds), limit_end, "test GPA").unwrap_err();
        assert!(
            matches!(
                error,
                Error::GuestMemoryAddressLimit {
                    memory_mib, end, limit_end: actual_limit, limit: "test GPA",
                } if memory_mib == exceeds && end == rejected_end && actual_limit == limit_end
            ),
            "{error:?}"
        );
        assert!(error.source().is_none());
    }
}

#[test]
fn ram_layout_rejects_end_gpa_overflow() {
    let size = u64::MAX - 4095;
    assert!(X86_LAYOUT.ranges(size).is_err());
    assert!(ARM64_LAYOUT.ranges(size).is_err());
}

#[test]
fn allocated_ram_is_zeroed_and_mirrors_its_ranges() {
    let ram = GuestRam::new(&ram_ranges(2)).unwrap();
    let [region] = ram.regions().collect::<Vec<_>>().try_into().unwrap();
    assert_eq!(region.guest_addr, RAM_START);
    assert_eq!(region.size, 2 * MIB);
    let host = ram
        .memory()
        .memory()
        .get_host_address(GuestAddress(RAM_START))
        .unwrap();
    assert_eq!(region.host_addr.as_ptr(), host);
    assert_eq!(host as usize % 4096, 0, "mmap returns page-aligned memory");

    let last = GuestAddress(RAM_START + 2 * MIB as u64 - 1);
    assert_eq!(ram.memory().memory().read_obj::<u8>(last).unwrap(), 0);
    ram.memory().memory().write_obj(0x4bu8, last).unwrap();
    assert_eq!(ram.memory().memory().read_obj::<u8>(last).unwrap(), 0x4b);
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
    assert_eq!(
        vm.unmap_attempts(),
        [
            (
                1 << 32,
                ram.boot_memory()
                    .get_host_address(GuestAddress(1 << 32))
                    .unwrap() as usize,
                MIB,
            ),
            (
                0,
                ram.boot_memory().get_host_address(GuestAddress(0)).unwrap() as usize,
                MIB,
            ),
        ]
    );
}

#[test]
fn a_rejected_mapping_returns_the_hypervisor_error_and_keeps_no_registration() {
    let mut ram = GuestRam::new(&ram_ranges(16)).unwrap();
    let vm = MockVm::failing_at(&[0]);
    let backing = Arc::downgrade(ram.boot_memory());

    assert!(matches!(
        ram.map(&vm),
        Err(Error::Hypervisor(HypervisorError::MapMemory { guest_addr, size, source }))
            if guest_addr == RAM_START && size == 16 * MIB
                && source.kind() == io::ErrorKind::OutOfMemory
    ));
    assert_eq!(ram.mapped, 0);
    assert!(vm.registrations().is_empty());
    let low_region = ram.regions().next().unwrap();
    assert_eq!(
        vm.calls(),
        [Call::map(&low_region), Call::unmap(&low_region)]
    );
    assert_eq!(vm.ioctl_calls(), [Call::map(&low_region)]);
    drop(ram);
    assert!(backing.upgrade().is_none());
}

#[test]
fn failed_second_map_unmaps_the_first_and_leaves_ram_remappable() {
    let mut ram = two_regions();
    let vm = MockVm::failing_at(&[1]);
    let [(map0, unmap0), (map1, unmap1)] = expected_calls(&ram)[..] else {
        panic!("two regions")
    };

    let error = ram.map(&vm).unwrap_err();
    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::MapMemory { guest_addr, size, .. })
            if guest_addr == 1 << 32 && size == MIB
    ));
    assert_eq!(vm.calls(), [map0, map1, unmap1, unmap0]);
    assert_eq!(vm.ioctl_calls(), [map0, map1, unmap0]);
    assert_eq!(ram.mapped, 0);
    assert!(vm.registrations().is_empty());

    let retry = MockVm::new();
    ram.map(&retry).unwrap();
    assert_eq!(retry.calls(), [map0, map1]);
    assert_eq!(retry.ioctl_calls(), [map0, map1]);
    assert_eq!(ram.mapped, 2);
    ram.unmap(&retry).unwrap();
}

#[test]
fn mock_rejects_a_duplicate_registration() {
    let ram = two_regions();
    let vm = MockVm::new();
    let region = ram.regions().next().unwrap();
    // SAFETY: GuestRam owns the backing and the mock only records its address.
    unsafe {
        vm.map_memory(&region).unwrap();
        assert!(matches!(
            vm.map_memory(&region),
            Err(HypervisorError::MapMemory { source, .. })
                if source.kind() == io::ErrorKind::AlreadyExists
        ));
    }
    let map = Call::map(&region);
    assert_eq!(vm.registrations(), [map].into());
    vm.unmap_memory(&region).unwrap();
    let expected = [map, map, Call::unmap(&region)];
    assert_eq!(vm.calls(), expected);
    assert_eq!(vm.ioctl_calls(), expected);
}

#[test]
fn unregistered_unmap_attempts_count_for_failure_injection_but_not_ioctls() {
    let ram = two_regions();
    let vm = MockVm::failing_at(&[3]);
    let mut regions = ram.regions();
    let low = regions.next().unwrap();
    let high = regions.next().unwrap();
    let map_low = Call::map(&low);
    let unmap_low = Call::unmap(&low);
    let unmap_high = Call::unmap(&high);
    let drop_vcpu = Call::DropVcpu { id: 0 };

    // SAFETY: GuestRam owns the backing and the mock only records its address.
    unsafe { vm.map_memory(&low) }.unwrap();
    vm.unmap_memory(&high).unwrap();
    assert_eq!(vm.registrations(), [map_low].into());
    drop(vm.create_vcpu(0).unwrap());
    assert!(matches!(
        vm.unmap_memory(&high),
        Err(HypervisorError::UnmapMemory { guest_addr, size, source })
            if guest_addr == high.guest_addr && size == high.size
                && source.kind() == io::ErrorKind::OutOfMemory
    ));
    assert_eq!(vm.registrations(), [map_low].into());
    vm.unmap_memory(&low).unwrap();
    assert!(vm.registrations().is_empty());
    assert_eq!(
        vm.calls(),
        [map_low, unmap_high, drop_vcpu, unmap_high, unmap_low]
    );
    assert_eq!(vm.ioctl_calls(), [map_low, drop_vcpu, unmap_low]);
    assert_eq!(
        vm.unmap_attempts(),
        [&high, &high, &low].map(|region| (
            region.guest_addr,
            region.host_addr.as_ptr() as usize,
            region.size,
        ))
    );
}

#[test]
fn failed_rollback_keeps_the_backing_alive() {
    let mut ram = two_regions();
    let vm = MockVm::failing_at(&[2, 4]);
    seed_second_registration(&ram, &vm);
    let weak = Arc::downgrade(ram.boot_memory());
    let [(map0, unmap0), (map1, unmap1)] = expected_calls(&ram)[..] else {
        panic!("two regions")
    };

    let error = ram.map(&vm).unwrap_err();
    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::MapMemory { .. })
    ));
    assert_eq!(vm.calls(), [map1, map0, map1, unmap1, unmap0]);
    assert_eq!(ram.mapped, 1);
    assert_eq!(vm.registrations(), [map0].into());

    drop(ram);
    assert!(
        weak.upgrade().is_some(),
        "a registered region keeps its backing"
    );
}

#[test]
fn a_map_failure_cleans_up_slices_before_returning() {
    let mut ram = two_regions();
    let vm = MockVm::failing_at(&[2]);
    seed_second_registration(&ram, &vm);
    let weak = Arc::downgrade(ram.boot_memory());
    let [(map0, unmap0), (map1, unmap1)] = expected_calls(&ram)[..] else {
        panic!("two regions")
    };

    assert!(ram.map(&vm).is_err());
    assert_eq!(vm.calls(), [map1, map0, map1, unmap1, unmap0]);
    assert_eq!(ram.mapped, 0);
    assert!(vm.registrations().is_empty());
    drop(ram);
    assert!(weak.upgrade().is_none());
}

#[test]
fn a_failed_cleanup_keeps_the_backing_alive() {
    let mut ram = two_regions();
    let vm = MockVm::failing_with(&[
        (2, io::ErrorKind::OutOfMemory),
        (3, io::ErrorKind::NotFound),
    ]);
    seed_second_registration(&ram, &vm);
    let weak = Arc::downgrade(ram.boot_memory());
    let [(map0, _), (map1, unmap1)] = expected_calls(&ram)[..] else {
        panic!("two regions")
    };

    assert!(matches!(
        ram.map(&vm),
        Err(Error::Hypervisor(HypervisorError::MapMemory { source, .. }))
            if source.kind() == io::ErrorKind::OutOfMemory
    ));
    assert_eq!(ram.mapped, 2);
    assert_eq!(vm.calls(), [map1, map0, map1, unmap1]);
    assert_eq!(vm.registrations(), [map0, map1].into());
    drop(ram);
    assert!(weak.upgrade().is_some());
}

#[test]
fn failed_unmap_keeps_state_and_retry_unmaps_only_the_remainder() {
    let mut ram = two_regions();
    let vm = MockVm::failing_at(&[3]);
    let [(map0, unmap0), (map1, unmap1)] = expected_calls(&ram)[..] else {
        panic!("two regions")
    };
    let weak = Arc::downgrade(&ram.memory().memory().into_inner());
    ram.map(&vm).unwrap();

    let error = ram.unmap(&vm).unwrap_err();
    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::UnmapMemory { guest_addr: 0, size, .. }) if size == MIB
    ));
    assert_eq!(ram.mapped, 1);
    assert_eq!(vm.calls(), [map0, map1, unmap1, unmap0]);
    assert_eq!(
        vm.unmap_attempts(),
        [
            (
                1 << 32,
                ram.boot_memory()
                    .get_host_address(GuestAddress(1 << 32))
                    .unwrap() as usize,
                MIB,
            ),
            (
                0,
                ram.boot_memory().get_host_address(GuestAddress(0)).unwrap() as usize,
                MIB,
            ),
        ]
    );

    let attempts_before_retry = vm.unmap_attempts().len();
    let low_region = ram.regions().next().unwrap();
    ram.unmap(&vm).unwrap();
    assert_eq!(ram.mapped, 0);
    assert_eq!(vm.calls(), [map0, map1, unmap1, unmap0, unmap0]);
    assert_eq!(vm.ioctl_calls(), [map0, map1, unmap1, unmap0, unmap0]);
    assert_eq!(
        vm.unmap_attempts()[attempts_before_retry..],
        [(0, low_region.host_addr.as_ptr() as usize, MIB)]
    );
    drop(ram);
    assert!(
        weak.upgrade().is_none(),
        "an unmapped RAM releases its backing"
    );
}

#[test]
fn drop_without_unmap_leaks_the_backing() {
    let mut ram = two_regions();
    let weak = Arc::downgrade(&ram.memory().memory().into_inner());
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
    assert!(vm.unmap_attempts().is_empty());
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

#[test]
fn registrations_cover_only_the_boot_regions_a_view_update_leaves_alone() {
    let mut ram = GuestRam::new(&ram_ranges(2)).unwrap();
    let extra = Arc::new(
        vm_memory::GuestRegionMmap::from_range(GuestAddress(1 << 32), 4096, None).unwrap(),
    );
    let grown = ram.memory().memory().insert_region(extra).unwrap();
    ram.memory().lock().unwrap().replace(grown);
    let vm = MockVm::new();

    ram.map(&vm).unwrap();
    ram.unmap(&vm).unwrap();

    let [boot] = ram.regions().collect::<Vec<_>>().try_into().unwrap();
    assert_eq!(boot.guest_addr, RAM_START);
    assert_eq!(
        vm.calls(),
        [Call::map(&boot), Call::unmap(&boot)],
        "the published hotplug region is never registered by GuestRam"
    );
}
