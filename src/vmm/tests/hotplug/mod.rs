// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Hotplug window tests: block ranges, slot mapping and rollback, discard,
//! slot removal, and the view devices load.

use std::sync::Arc;

use vm_memory::{Bytes, GuestAddress, GuestAddressSpace, GuestMemoryBackend};

use super::*;
use crate::mock_vm::{Call, MockVm};

const MIB: u64 = 1 << 20;

fn view() -> GuestMemoryView {
    GuestMemoryView::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x1_0000)]).unwrap())
}

fn window(vm: MockVm, capacity_mib: u32) -> (Arc<MockVm>, GuestMemoryView, HotplugMemory<MockVm>) {
    let vm = Arc::new(vm);
    let view = view();
    let memory = HotplugMemory::new(Arc::clone(&vm), view.clone(), capacity_mib).unwrap();
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
fn capacity_must_be_a_positive_multiple_of_a_slot() {
    for capacity in [0, 64, 129] {
        let error = HotplugMemory::new(Arc::new(MockVm::new()), view(), capacity)
            .err()
            .unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
    let (_, _, memory) = window(MockVm::new(), 256);
    assert_eq!((memory.base(), memory.size()), (HOTPLUG_START, 256 * MIB));
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
