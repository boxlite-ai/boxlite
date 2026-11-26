// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Hotplug window tests: block ranges, slot mapping and rollback, discard,
//! slot removal, and the view devices load.

use std::sync::Arc;

use vm_memory::{Bytes, GuestAddress, GuestAddressSpace, GuestMemoryBackend};

use super::*;
use crate::mock_vm::{Call, MockVm};

const MIB: u64 = 1 << 20;
const GIB: u64 = 1024 * MIB;
const HOTPLUG_START: u64 = 4 * GIB;

fn view() -> GuestMemoryView {
    GuestMemoryView::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x1_0000)]).unwrap())
}

fn window(vm: MockVm, capacity_mib: u32) -> (Arc<MockVm>, GuestMemoryView, HotplugMemory<MockVm>) {
    let vm = Arc::new(vm);
    let view = view();
    let window =
        HotplugWindow::plan(&[(GuestAddress(0), 0x1_0000)], capacity_mib, 64 * GIB, 16).unwrap();
    let memory = HotplugMemory::new(Arc::clone(&vm), view.clone(), window);
    (vm, view, memory)
}

fn block_addr(block: u64) -> GuestAddress {
    GuestAddress(HOTPLUG_START + block * BLOCK_SIZE)
}

fn slot_calls(vm: &MockVm) -> Vec<(bool, u64, usize)> {
    vm.calls()
        .into_iter()
        .filter_map(|call| match call {
            Call::Map {
                guest_addr, size, ..
            } => Some((true, guest_addr, size)),
            Call::Unmap {
                guest_addr, size, ..
            } => Some((false, guest_addr, size)),
            _ => None,
        })
        .collect()
}

const SLOT: usize = SLOT_SIZE as usize;
const SECOND_SLOT: u64 = HOTPLUG_START + SLOT_SIZE;

#[test]
#[cfg(target_arch = "x86_64")]
fn window_starts_after_high_boot_ram() {
    use crate::memory::{GuestRam, ram_ranges};

    let ranges = ram_ranges(6144);
    let mut ram = GuestRam::new(&ranges).unwrap();
    let vm = Arc::new(MockVm::new());
    ram.map(vm.as_ref()).unwrap();
    let window = HotplugWindow::plan(&ranges, 128, 64 * GIB, 1).unwrap();
    let mut memory = HotplugMemory::new(Arc::clone(&vm), ram.memory().clone(), window);

    assert_eq!(memory.base(), 7 * GIB);
    memory
        .plug(memory.blocks(memory.base(), 1).unwrap())
        .unwrap();
    assert_eq!(slot_calls(&vm)[2], (true, 7 * GIB, SLOT));
    drop(memory);
    ram.unmap(vm.as_ref()).unwrap();
}

#[test]
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_rejects_the_old_window_and_maps_the_planned_window() {
    use boxlite_hypervisor::{Error, KvmVm};

    use crate::{
        cpu_features::X86MemoryCaps,
        memory::{GuestRam, ram_ranges},
    };

    let ranges = ram_ranges(6144);
    let mut ram = GuestRam::new(&ranges).unwrap();
    let vm = Arc::new(KvmVm::new().unwrap());
    ram.map(vm.as_ref()).unwrap();
    let old_window = HotplugWindow {
        base: 4 * GIB,
        slots: 1,
    };
    let mut old = HotplugMemory::new(Arc::clone(&vm), ram.memory().clone(), old_window);
    let error = old.plug(0..1).unwrap_err();
    assert!(
        matches!(error.get_ref().and_then(|e| e.downcast_ref::<Error>()),
        Some(Error::MapMemory { source, .. }) if source.kind() == io::ErrorKind::AlreadyExists)
    );

    let caps = X86MemoryCaps::from_cpuid(vm.supported_cpuid()).unwrap();
    let window = HotplugWindow::plan(&ranges, 128, caps.physical_end, 1).unwrap();
    let mut memory = HotplugMemory::new(Arc::clone(&vm), ram.memory().clone(), window);
    assert_eq!(memory.base(), 7 * GIB);
    memory.plug(0..1).unwrap();
    ram.memory()
        .memory()
        .write_obj(0x2au8, GuestAddress(7 * GIB))
        .unwrap();
    memory.unplug(0..1).unwrap();
    ram.unmap(vm.as_ref()).unwrap();
}

#[test]
fn capacity_must_be_a_positive_multiple_of_a_slot() {
    for capacity in [0, 64, 129] {
        let error = HotplugWindow::plan(&[], capacity, 64 * GIB, 16).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
    let (_, _, memory) = window(MockVm::new(), 256);
    assert_eq!((memory.base(), memory.size()), (HOTPLUG_START, 256 * MIB));
}

#[test]
#[cfg(target_arch = "x86_64")]
fn placement_and_capacity_follow_linux_memory_block_alignment() {
    use crate::memory::ram_ranges;

    for (boot_mib, base, block_mib) in [
        (512, 4 * GIB, 128),
        (3072, 4 * GIB, 128),
        (3073, 4 * GIB + SLOT_SIZE, 128),
        (63 * 1024, 64 * GIB, 2048),
        (64 * 1024, 65 * GIB, 1024),
        (63 * 1024 + 128, 64 * GIB + SLOT_SIZE, 128),
    ] {
        let boot = ram_ranges(boot_mib);
        let plan = HotplugWindow::plan(&boot, block_mib, 128 * GIB, 16).unwrap();
        assert_eq!(plan.base, base, "{boot_mib} MiB of boot RAM");
        assert!(HotplugWindow::plan(&boot, block_mib / 2, 128 * GIB, 16).is_err());
    }
}

#[test]
fn window_respects_address_and_slot_limits() {
    let boot = [(GuestAddress(4 * GIB), GIB as usize)];
    assert!(HotplugWindow::plan(&boot, 128, 5 * GIB + SLOT_SIZE, 1).is_ok());
    assert!(HotplugWindow::plan(&boot, 256, 5 * GIB + SLOT_SIZE, 2).is_err());
    assert!(HotplugWindow::plan(&boot, 128, 5 * GIB + SLOT_SIZE, 0).is_err());

    let boot = [(GuestAddress(GUEST_PLUGGABLE_END - 2 * SLOT_SIZE), SLOT)];
    assert!(HotplugWindow::plan(&boot, 128, 2 * GUEST_PLUGGABLE_END, 1).is_ok());
    assert!(HotplugWindow::plan(&boot, 256, 2 * GUEST_PLUGGABLE_END, 2).is_err());
    assert!(HotplugWindow::plan(&[(GuestAddress(u64::MAX), 1)], 128, u64::MAX, 1).is_err());
    assert!(HotplugWindow::plan(&[(GuestAddress(u64::MAX - 1), 1)], 128, u64::MAX, 1).is_err());
}

#[test]
fn block_ranges_reject_empty_misaligned_and_outside_requests() {
    let (_, _, memory) = window(MockVm::new(), 128);
    let last = HOTPLUG_START + SLOT_SIZE - BLOCK_SIZE;
    assert_eq!(memory.blocks(HOTPLUG_START, 1), Some(0..1));
    assert_eq!(memory.blocks(last, 1), Some(63..64));
    assert_eq!(memory.blocks(last, 2), None);
    assert_eq!(memory.blocks(HOTPLUG_START, 0), None);
    assert_eq!(memory.blocks(HOTPLUG_START + 4096, 1), None);
    assert_eq!(memory.blocks(HOTPLUG_START - BLOCK_SIZE, 1), None);
    assert_eq!(memory.blocks(u64::MAX - 1, u16::MAX), None);
}

#[test]
fn plug_maps_each_needed_slot_once_and_publishes_it() {
    let (vm, view, mut memory) = window(MockVm::new(), 256);
    let blocks = memory.blocks(SECOND_SLOT - BLOCK_SIZE, 2).unwrap();
    memory.plug(blocks.clone()).unwrap();

    assert_eq!(
        slot_calls(&vm),
        [(true, HOTPLUG_START, SLOT), (true, SECOND_SLOT, SLOT)]
    );
    assert_eq!(memory.state(blocks), BlockState::Plugged);
    assert_eq!(memory.state(0..2), BlockState::Unplugged);
    assert_eq!(memory.state(62..64), BlockState::Mixed);
    assert_eq!(
        (memory.plugged_bytes(), memory.mapped_bytes()),
        (4 * MIB, 256 * MIB)
    );
    view.memory()
        .write_obj(7u8, GuestAddress(SECOND_SLOT))
        .unwrap();

    memory
        .plug(memory.blocks(HOTPLUG_START, 1).unwrap())
        .unwrap();
    assert_eq!(slot_calls(&vm).len(), 2, "both slots were already mapped");
}

#[test]
fn a_failed_slot_map_unregisters_the_slots_this_plug_added() {
    // Call 0 maps the first slot; call 1, the second slot, fails.
    let (vm, view, mut memory) = window(MockVm::failing_at(&[1]), 256);
    let blocks = memory.blocks(SECOND_SLOT - BLOCK_SIZE, 2).unwrap();

    memory.plug(blocks.clone()).unwrap_err();

    assert_eq!(
        slot_calls(&vm),
        [
            (true, HOTPLUG_START, SLOT),
            (true, SECOND_SLOT, SLOT),
            (false, HOTPLUG_START, SLOT)
        ]
    );
    assert_eq!(memory.state(blocks), BlockState::Unplugged);
    assert_eq!((memory.plugged_bytes(), memory.mapped_bytes()), (0, 0));
    assert!(!view.memory().address_in_range(GuestAddress(HOTPLUG_START)));
}

#[test]
fn unplugging_part_of_a_mapped_slot_discards_those_blocks() {
    let (vm, view, mut memory) = window(MockVm::new(), 128);
    memory
        .plug(memory.blocks(HOTPLUG_START, 2).unwrap())
        .unwrap();
    view.memory().write_obj(0x5au8, block_addr(1)).unwrap();

    memory
        .unplug(memory.blocks(block_addr(1).0, 1).unwrap())
        .unwrap();

    assert_eq!(slot_calls(&vm).len(), 1, "the slot stays registered");
    assert_eq!(memory.mapped_bytes(), SLOT_SIZE);
    assert_eq!(memory.plugged_bytes(), BLOCK_SIZE);
    // Darwin's MADV_DONTNEED discards only under memory pressure.
    #[cfg(target_os = "linux")]
    assert_eq!(view.memory().read_obj::<u8>(block_addr(1)).unwrap(), 0);
}

#[test]
fn unplugging_a_slot_unregisters_it_and_a_held_snapshot_keeps_it_readable() {
    let (vm, view, mut memory) = window(MockVm::new(), 128);
    memory
        .plug(memory.blocks(HOTPLUG_START, 1).unwrap())
        .unwrap();
    view.memory().write_obj(9u8, block_addr(0)).unwrap();
    let held = view.memory();

    memory.unplug_all().unwrap();

    assert_eq!(
        slot_calls(&vm),
        [(true, HOTPLUG_START, SLOT), (false, HOTPLUG_START, SLOT)]
    );
    assert_eq!((memory.plugged_bytes(), memory.mapped_bytes()), (0, 0));
    assert!(view.memory().read_obj::<u8>(block_addr(0)).is_err());
    assert_eq!(held.read_obj::<u8>(block_addr(0)).unwrap(), 9);
}

#[test]
fn a_failed_slot_unmap_keeps_the_slot_mapped_and_visible() {
    // Call 0 maps the slot; call 1, its removal, fails.
    let (_, view, mut memory) = window(MockVm::failing_at(&[1]), 128);
    let blocks = memory.blocks(HOTPLUG_START, 1).unwrap();
    memory.plug(blocks.clone()).unwrap();

    memory.unplug(blocks.clone()).unwrap_err();

    assert_eq!(memory.state(blocks), BlockState::Unplugged);
    assert_eq!(memory.mapped_bytes(), SLOT_SIZE);
    assert!(view.memory().address_in_range(GuestAddress(HOTPLUG_START)));
}

#[test]
fn drop_unregisters_every_mapped_slot() {
    let (vm, _, mut memory) = window(MockVm::new(), 256);
    memory
        .plug(memory.blocks(HOTPLUG_START, 1).unwrap())
        .unwrap();
    memory.plug(memory.blocks(SECOND_SLOT, 1).unwrap()).unwrap();

    drop(memory);

    assert_eq!(
        slot_calls(&vm),
        [
            (true, HOTPLUG_START, SLOT),
            (true, SECOND_SLOT, SLOT),
            (false, HOTPLUG_START, SLOT),
            (false, SECOND_SLOT, SLOT)
        ]
    );
}

#[test]
fn unplug_after_a_poisoned_view_lock_still_removes_the_slot_everywhere() {
    let (vm, view, mut memory) = window(MockVm::new(), 128);
    let blocks = memory.blocks(HOTPLUG_START, 1).unwrap();
    memory.plug(blocks.clone()).unwrap();
    let poisoner = view.clone();
    std::thread::spawn(move || {
        let _guard = poisoner.lock().unwrap();
        panic!("poison the view lock");
    })
    .join()
    .unwrap_err();

    memory.unplug(blocks).unwrap();

    assert_eq!(
        slot_calls(&vm),
        [(true, HOTPLUG_START, SLOT), (false, HOTPLUG_START, SLOT)]
    );
    assert_eq!(memory.mapped_bytes(), 0);
    assert!(!view.memory().address_in_range(GuestAddress(HOTPLUG_START)));
}

#[test]
fn failed_plug_rollback_reports_the_retained_mapping() {
    let (_vm, view, mut memory) = window(MockVm::failing_at(&[1, 2]), 256);
    let blocks = memory.blocks(SECOND_SLOT - BLOCK_SIZE, 2).unwrap();
    assert!(memory.plug(blocks.clone()).is_err());
    assert_eq!(memory.state(blocks.clone()), BlockState::Unplugged);
    assert_eq!(memory.mapped_bytes(), SLOT_SIZE);
    assert!(!view.memory().address_in_range(GuestAddress(HOTPLUG_START)));

    memory.unplug_all().unwrap();
    assert_eq!(memory.mapped_bytes(), 0);
    memory.plug(blocks).unwrap();
}

#[test]
fn a_published_slot_left_mapped_can_be_replugged() {
    let (_, view, mut memory) = window(MockVm::failing_at(&[1]), 256);
    let blocks = memory.blocks(HOTPLUG_START, 1).unwrap();
    memory.plug(blocks.clone()).unwrap();

    assert!(memory.unplug(blocks.clone()).is_err());
    assert!(view.memory().address_in_range(GuestAddress(HOTPLUG_START)));
    assert_eq!(memory.state(blocks.clone()), BlockState::Unplugged);

    memory.plug(blocks.clone()).unwrap();
    assert_eq!(memory.state(blocks), BlockState::Plugged);
    assert_eq!(memory.mapped_bytes(), SLOT_SIZE);
}

#[test]
fn retained_empty_bytes_exclude_partly_occupied_mappings() {
    let (_, _, mut memory) = window(MockVm::failing_at(&[2]), 256);
    let first = memory.blocks(HOTPLUG_START, 1).unwrap();
    let second = memory.blocks(SECOND_SLOT, 1).unwrap();
    memory.plug(first.clone()).unwrap();
    memory.plug(second).unwrap();
    assert_eq!(memory.retained_empty_mapped_bytes(), 0);

    assert!(memory.unplug(first.clone()).is_err());
    assert_eq!(memory.retained_empty_mapped_bytes(), SLOT_SIZE);
    assert_eq!(memory.mapped_bytes(), 2 * SLOT_SIZE);

    memory.unplug(first).unwrap();
    assert_eq!(memory.retained_empty_mapped_bytes(), 0);
    assert_eq!(memory.mapped_bytes(), SLOT_SIZE);
}
