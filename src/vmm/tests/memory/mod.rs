// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest RAM layout and allocation.

use std::error::Error as _;

use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend};

use super::{GuestRam, MAX_MEMORY_MIB, RAM_START, ram_ranges};
use crate::error::Error;

const MIB: usize = 1 << 20;

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
    let ram = GuestRam::new(&[(GuestAddress(0), MIB), (GuestAddress(1 << 32), MIB)]).unwrap();
    let starts: Vec<u64> = ram.regions().map(|region| region.guest_addr).collect();
    assert_eq!(starts, [0, 1 << 32]);
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
