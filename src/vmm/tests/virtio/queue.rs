// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Queue facade tests: dense validation, notification drain, deferred
//! completion, backpressure and quiescent queue snapshots.

use std::sync::Arc;

use virtio_queue::{Queue, QueueT, desc::split::Descriptor};
use vm_memory::{Address, Bytes, GuestAddress};

use crate::{
    memory::GuestMemoryMmap,
    virtio::{
        DeviceError, SnapshotError,
        queue::{Completion, QueueError, VIRTIO_F_EVENT_IDX, VIRTIO_F_INDIRECT_DESC, VirtQueues},
    },
};

const SIZE: u16 = 8;
const DESC: u64 = 0x1000;
const DATA: u64 = 0x7000;
const AVAIL: u64 = 0x8000;
const INDIRECT: u64 = 0x9000;
const USED: u64 = 0xa000;
const DESC2: u64 = 0xb000;
const AVAIL2: u64 = 0xc000;
const USED2: u64 = 0xd000;
const NEXT: u16 = 1;
const INDIRECT_FLAG: u16 = 4;

fn memory() -> Arc<GuestMemoryMmap> {
    Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap())
}

fn read_u16(memory: &GuestMemoryMmap, address: GuestAddress) -> u16 {
    u16::from_le(memory.read_obj(address).unwrap())
}

fn write_u16(memory: &GuestMemoryMmap, address: GuestAddress, value: u16) {
    memory.write_obj(value.to_le(), address).unwrap();
}

fn read_u32(memory: &GuestMemoryMmap, address: GuestAddress) -> u32 {
    u32::from_le(memory.read_obj(address).unwrap())
}

fn ready_queue() -> Queue {
    ready_queue_at(DESC, AVAIL, USED)
}

fn ready_queue_at(desc_table: u64, avail_ring: u64, used_ring: u64) -> Queue {
    let mut queue = Queue::new(SIZE).unwrap();
    queue.try_set_size(SIZE).unwrap();
    queue
        .try_set_desc_table_address(GuestAddress(desc_table))
        .unwrap();
    queue
        .try_set_avail_ring_address(GuestAddress(avail_ring))
        .unwrap();
    queue
        .try_set_used_ring_address(GuestAddress(used_ring))
        .unwrap();
    queue.set_ready(true);
    queue
}

fn prepared(
    queue: Queue,
    event_idx: bool,
    indirect: bool,
    memory: &Arc<GuestMemoryMmap>,
) -> VirtQueues {
    VirtQueues::prepare(
        vec![queue],
        &[SIZE],
        event_idx,
        indirect,
        Arc::clone(memory),
    )
    .unwrap()
}

fn write_desc_at(
    memory: &GuestMemoryMmap,
    desc_table: u64,
    index: u16,
    addr: u64,
    len: u32,
    flags: u16,
    next: u16,
) {
    let address = GuestAddress(desc_table + u64::from(index) * 16);
    memory
        .write_obj(Descriptor::new(addr, len, flags, next), address)
        .unwrap();
}

fn write_desc(memory: &GuestMemoryMmap, index: u16, addr: u64, len: u32, flags: u16, next: u16) {
    write_desc_at(memory, DESC, index, addr, len, flags, next);
}

fn add_chain_at(memory: &GuestMemoryMmap, avail_ring: u64, head: u16) {
    let index = read_u16(memory, GuestAddress(avail_ring + 2));
    let slot = GuestAddress(avail_ring + 4 + 2 * u64::from(index % SIZE));
    write_u16(memory, slot, head);
    write_u16(memory, GuestAddress(avail_ring + 2), index.wrapping_add(1));
}

fn add_chain(memory: &GuestMemoryMmap, head: u16) {
    add_chain_at(memory, AVAIL, head);
}

fn used_idx_at(memory: &GuestMemoryMmap, used_ring: u64) -> u16 {
    read_u16(memory, GuestAddress(used_ring + 2))
}

fn used_idx(memory: &GuestMemoryMmap) -> u16 {
    used_idx_at(memory, USED)
}

fn used_entry_at(memory: &GuestMemoryMmap, used_ring: u64, index: u16) -> (u32, u32) {
    let address = GuestAddress(used_ring + 4 + 8 * u64::from(index % SIZE));
    (
        read_u32(memory, address),
        read_u32(memory, address.unchecked_add(4)),
    )
}

fn used_entry(memory: &GuestMemoryMmap, index: u16) -> (u32, u32) {
    used_entry_at(memory, USED, index)
}

fn used_flags(memory: &GuestMemoryMmap) -> u16 {
    read_u16(memory, GuestAddress(USED))
}

fn set_used_event(memory: &GuestMemoryMmap, value: u16) {
    write_u16(memory, GuestAddress(AVAIL + 4 + 2 * u64::from(SIZE)), value);
}

fn avail_event(memory: &GuestMemoryMmap) -> u16 {
    read_u16(memory, GuestAddress(USED + 4 + 8 * u64::from(SIZE)))
}

#[test]
fn feature_bits_match_virtio() {
    assert_eq!(VIRTIO_F_INDIRECT_DESC, 1 << 28);
    assert_eq!(VIRTIO_F_EVENT_IDX, 1 << 29);
}

#[test]
fn prepare_accepts_a_dense_ready_queue() {
    let memory = memory();
    let queues = VirtQueues::prepare(
        vec![ready_queue()],
        &[SIZE],
        true,
        false,
        Arc::clone(&memory),
    )
    .unwrap();
    let state = queues.state(0).expect("queue 0 exists");
    assert!(state.event_idx_enabled);
    assert_eq!(state.size, SIZE);
    assert!(queues.is_ready(0));
    assert_eq!(queues.len(), 1);
    assert_eq!(queues.max_size(0), Some(SIZE));
}

#[test]
fn prepare_requires_one_queue_per_slot() {
    let memory = memory();
    assert_eq!(
        VirtQueues::prepare(
            vec![ready_queue()],
            &[SIZE, SIZE],
            false,
            false,
            Arc::clone(&memory)
        )
        .err(),
        Some(QueueError::Count {
            expected: 2,
            actual: 1
        })
    );
}

#[test]
fn prepare_checks_each_slot_max_size() {
    let memory = memory();
    assert_eq!(
        VirtQueues::prepare(
            vec![Queue::new(4).unwrap()],
            &[SIZE],
            false,
            false,
            Arc::clone(&memory)
        )
        .err(),
        Some(QueueError::MaxSize {
            expected: SIZE,
            actual: 4
        })
    );
}

#[test]
fn prepare_keeps_unready_queues_but_applies_event_idx() {
    let memory = memory();
    let queues = VirtQueues::prepare(
        vec![Queue::new(SIZE).unwrap()],
        &[SIZE],
        true,
        false,
        Arc::clone(&memory),
    )
    .unwrap();
    assert!(!queues.is_ready(0));
    assert!(queues.state(0).unwrap().event_idx_enabled);
}

#[test]
fn prepare_rejects_a_zero_avail_ring() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.try_set_avail_ring_address(GuestAddress(0)).unwrap();
    assert_eq!(
        VirtQueues::prepare(vec![queue], &[SIZE], false, false, Arc::clone(&memory)).err(),
        Some(QueueError::Invalid)
    );
}

#[test]
fn prepare_rejects_rings_outside_memory() {
    let memory = memory();
    let mut queue = ready_queue();
    queue
        .try_set_used_ring_address(GuestAddress(0x1_0000))
        .unwrap();
    assert_eq!(
        VirtQueues::prepare(vec![queue], &[SIZE], false, false, Arc::clone(&memory)).err(),
        Some(QueueError::Memory)
    );
}

#[test]
fn prepare_reapplies_event_idx_after_reset() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_event_idx(true);
    queue.reset();
    assert!(!queue.event_idx_enabled());
    let queues =
        VirtQueues::prepare(vec![queue], &[SIZE], true, false, Arc::clone(&memory)).unwrap();
    assert!(queues.state(0).unwrap().event_idx_enabled);
}

#[test]
fn drain_completes_every_available_chain() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    let mut heads = Vec::new();
    let notify = queues
        .drain(0, |chain| {
            heads.push(chain.head_index());
            Ok(Completion::Used(
                chain.map(|descriptor| descriptor.len()).sum(),
            ))
        })
        .unwrap();
    assert!(notify);
    assert_eq!(heads, vec![0, 1, 2]);
    let state = queues.state(0).unwrap();
    assert_eq!(state.next_avail, 3);
    assert_eq!(state.next_used, 3);
    assert_eq!(used_idx(&memory), 3);
    assert_eq!(used_entry(&memory, 0), (0, 4));
    assert_eq!(used_entry(&memory, 1), (1, 4));
    assert_eq!(used_entry(&memory, 2), (2, 4));
}

#[test]
fn empty_drain_does_not_interrupt() {
    for event_idx in [false, true] {
        let memory = memory();
        let mut queues = prepared(ready_queue(), event_idx, false, &memory);
        let notify = queues.drain(0, |_| panic!("no chain")).unwrap();
        assert!(!notify);
        assert_eq!(used_idx(&memory), 0);
        assert_eq!(used_flags(&memory), 0);
        assert_eq!(avail_event(&memory), 0);
    }
}

#[test]
fn without_event_idx_one_interrupt_per_batch() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for index in 0..4 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(queues.drain(0, |_| Ok(Completion::Used(4))).unwrap());
    assert!(!queues.drain(0, |_| panic!("empty")).unwrap());
    assert_eq!(used_flags(&memory), 0);
}

#[test]
fn no_interrupt_suppresses_drain_completion() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for (head, flags) in [(0, 1), (1, 0), (2, 2)] {
        write_desc(&memory, head, DATA, 4, 0, 0);
        add_chain(&memory, head);
        let notify = queues
            .drain(0, |_| {
                write_u16(&memory, GuestAddress(AVAIL), flags);
                Ok(Completion::Used(4))
            })
            .unwrap();
        assert_eq!(used_idx(&memory), head + 1);
        assert_eq!(used_entry(&memory, head), (u32::from(head), 4));
        assert_eq!(
            notify,
            flags & 1 == 0,
            "NO_INTERRUPT must suppress the batch"
        );
    }
}

#[test]
fn no_interrupt_suppresses_deferred_completion() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for (head, flags) in [(0, 1), (1, 0), (2, 2)] {
        write_desc(&memory, head, DATA, 4, 0, 0);
        add_chain(&memory, head);
        assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
        write_u16(&memory, GuestAddress(AVAIL), flags);
        let notify = queues.complete(0, head, 4).unwrap();
        assert_eq!(used_idx(&memory), head + 1);
        assert_eq!(used_entry(&memory, head), (u32::from(head), 4));
        assert_eq!(
            notify,
            flags & 1 == 0,
            "NO_INTERRUPT must suppress completion"
        );
    }
}

#[test]
fn event_idx_suppresses_below_threshold() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), true, false, &memory);
    set_used_event(&memory, 5);
    for index in 0..2 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(!queues.drain(0, |_| Ok(Completion::Used(4))).unwrap());
    for index in 2..6 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(queues.drain(0, |_| Ok(Completion::Used(4))).unwrap());
}

#[test]
fn event_idx_wraps_used_indices() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_next_used(u16::MAX - 3);
    let mut queues = prepared(queue, true, false, &memory);
    set_used_event(&memory, u16::MAX - 3);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert!(queues.drain(0, |_| Ok(Completion::Used(4))).unwrap());
    assert!(!queues.drain(0, |_| panic!("empty")).unwrap());
}

#[test]
fn drain_keeps_work_that_arrives_while_disabled() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    let mut count = 0;
    let notify = queues
        .drain(0, |_| {
            count += 1;
            if count == 1 {
                write_desc(&memory, 1, DATA, 4, 0, 0);
                add_chain(&memory, 1);
            }
            Ok(Completion::Used(4))
        })
        .unwrap();
    assert!(notify);
    assert_eq!(count, 2);
    assert_eq!(used_idx(&memory), 2);
}

#[test]
fn drain_rejects_indirect_descriptors_when_not_negotiated() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);
    let mut completed = false;
    let result = queues.drain(0, |_| {
        completed = true;
        Ok(Completion::Used(4))
    });
    assert_eq!(result, Err(DeviceError::NeedsReset("indirect descriptor")));
    assert!(!completed);
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn drain_rejects_a_mid_chain_indirect_descriptor() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, NEXT, 1);
    write_desc(&memory, 1, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);
    assert_eq!(
        queues.drain(0, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("indirect descriptor"))
    );
}

#[test]
fn drain_accepts_indirect_descriptors_when_negotiated() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, true, &memory);
    memory
        .write_obj(Descriptor::new(DATA, 4, 0, 0), GuestAddress(INDIRECT))
        .unwrap();
    write_desc(&memory, 0, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);
    let notify = queues
        .drain(0, |chain| {
            Ok(Completion::Used(
                chain.map(|descriptor| descriptor.len()).sum(),
            ))
        })
        .unwrap();
    assert!(notify);
    assert_eq!(used_entry(&memory, 0), (0, 4));
}

#[test]
fn drain_maps_invalid_avail_idx_to_needs_reset() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_u16(&memory, GuestAddress(AVAIL + 2), SIZE + 1);
    assert_eq!(
        queues.drain(0, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("virtio queue"))
    );
}

#[test]
fn drain_propagates_completion_errors() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    let result = queues.drain(0, |_| Err(DeviceError::Fatal("backend")));
    assert_eq!(result, Err(DeviceError::Fatal("backend")));
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn drain_rejects_a_malformed_chain() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, NEXT, 9);
    add_chain(&memory, 0);
    assert_eq!(
        queues.drain(0, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("virtio descriptor"))
    );
}

#[test]
fn drain_rejects_a_chain_cycle() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, NEXT, 0);
    add_chain(&memory, 0);
    assert_eq!(
        queues.drain(0, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("virtio descriptor"))
    );
}

#[test]
fn complete_rejects_an_out_of_range_head() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    assert_eq!(
        queues.complete(0, SIZE, 4),
        Err(DeviceError::NeedsReset("virtio queue"))
    );
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn drain_leaves_a_deferred_chain_for_later_completion() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);

    let notify = queues.drain(0, |_| Ok(Completion::Deferred)).unwrap();
    assert!(!notify);
    let state = queues.state(0).unwrap();
    assert_eq!(state.next_avail, 1);
    assert_eq!(state.next_used, 0);
    assert_eq!(used_idx(&memory), 0);

    assert!(queues.complete(0, 0, 4).unwrap());
    let state = queues.state(0).unwrap();
    assert_eq!(state.next_used, 1);
    assert_eq!(used_idx(&memory), 1);
    assert_eq!(used_entry(&memory, 0), (0, 4));
}

#[test]
fn drain_adds_used_entries_in_completion_order_for_a_mixed_batch() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }

    let notify = queues
        .drain(0, |chain| match chain.head_index() {
            0 => Ok(Completion::Used(4)),
            1 => Ok(Completion::Deferred),
            _ => Ok(Completion::Used(6)),
        })
        .unwrap();
    assert!(notify);
    let state = queues.state(0).unwrap();
    assert_eq!(state.next_avail, 3);
    assert_eq!(state.next_used, 2);
    assert_eq!(used_entry(&memory, 0), (0, 4));
    assert_eq!(used_entry(&memory, 1), (2, 6));

    assert!(queues.complete(0, 1, 8).unwrap());
    let state = queues.state(0).unwrap();
    assert_eq!(state.next_used, 3);
    assert_eq!(used_idx(&memory), 3);
    assert_eq!(used_entry(&memory, 2), (1, 8));
}

#[test]
fn a_deferred_chain_does_not_end_the_notification_drain() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);

    let mut calls = 0;
    let notify = queues
        .drain(0, |_| {
            calls += 1;
            if calls == 1 {
                write_desc(&memory, 1, DATA, 4, 0, 0);
                add_chain(&memory, 1);
                Ok(Completion::Deferred)
            } else {
                Ok(Completion::Used(4))
            }
        })
        .unwrap();
    assert!(notify);
    assert_eq!(calls, 2);
    let state = queues.state(0).unwrap();
    assert_eq!(state.next_avail, 2);
    assert_eq!(state.next_used, 1);
    assert_eq!(used_entry(&memory, 0), (1, 4));
}

#[test]
fn drain_rejects_a_deferred_indirect_chain_when_not_negotiated() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);

    let mut processed = false;
    let result = queues.drain(0, |_| {
        processed = true;
        Ok(Completion::Deferred)
    });
    assert_eq!(result, Err(DeviceError::NeedsReset("indirect descriptor")));
    assert!(!processed);
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn event_idx_notification_decisions_apply_to_later_completions() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), true, false, &memory);
    set_used_event(&memory, 0);
    for index in 0..2 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
    assert!(queues.complete(0, 0, 4).unwrap());
    assert!(!queues.complete(0, 1, 4).unwrap());
}

#[test]
fn event_idx_crossing_notifies_on_the_completion_that_crosses() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), true, false, &memory);
    set_used_event(&memory, 2);
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
    assert!(!queues.complete(0, 0, 4).unwrap());
    assert!(!queues.complete(0, 1, 4).unwrap());
    assert!(queues.complete(0, 2, 4).unwrap());
}

#[test]
fn drain_resolves_event_idx_once_per_batch() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), true, false, &memory);
    set_used_event(&memory, 1);
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }

    assert!(queues.drain(0, |_| Ok(Completion::Used(4))).unwrap());
    assert_eq!(used_idx(&memory), 3);
}

#[test]
fn complete_rejects_a_head_that_was_never_deferred() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);

    assert_eq!(
        queues.complete(0, 0, 4),
        Err(DeviceError::NeedsReset("virtio deferred chain"))
    );
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn complete_rejects_a_second_completion() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);

    assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
    assert!(queues.complete(0, 0, 4).unwrap());
    assert_eq!(
        queues.complete(0, 0, 4),
        Err(DeviceError::NeedsReset("virtio deferred chain"))
    );
    assert_eq!(used_idx(&memory), 1);
}

#[test]
fn complete_rejects_a_completion_on_the_wrong_queue() {
    let memory = memory();
    let mut queues = VirtQueues::prepare(
        vec![ready_queue(), ready_queue_at(DESC2, AVAIL2, USED2)],
        &[SIZE, SIZE],
        false,
        false,
        Arc::clone(&memory),
    )
    .unwrap();
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());

    assert_eq!(
        queues.complete(1, 0, 4),
        Err(DeviceError::NeedsReset("virtio deferred chain"))
    );
    assert_eq!(used_idx_at(&memory, USED2), 0);
    assert_eq!(used_idx(&memory), 0);

    assert!(queues.complete(0, 0, 4).unwrap());
}

#[test]
fn deferred_chains_complete_out_of_order() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());

    assert!(queues.complete(0, 2, 6).unwrap());
    assert!(queues.complete(0, 0, 4).unwrap());
    assert!(queues.complete(0, 1, 5).unwrap());
    assert_eq!(used_entry(&memory, 0), (2, 6));
    assert_eq!(used_entry(&memory, 1), (0, 4));
    assert_eq!(used_entry(&memory, 2), (1, 5));
    assert_eq!(used_idx(&memory), 3);
}

#[test]
fn drain_rejects_a_duplicate_deferred_head() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    add_chain(&memory, 0);

    assert_eq!(
        queues.drain(0, |_| Ok(Completion::Deferred)),
        Err(DeviceError::NeedsReset("virtio deferred chain"))
    );
    assert_eq!(used_idx(&memory), 0);
    assert!(queues.complete(0, 0, 4).unwrap());
    assert_eq!(used_idx(&memory), 1);
}

#[test]
fn dense_multi_queue_indices_are_preserved() {
    let memory = memory();
    let mut queues = VirtQueues::prepare(
        vec![ready_queue(), Queue::new(SIZE).unwrap()],
        &[SIZE, SIZE],
        false,
        false,
        Arc::clone(&memory),
    )
    .unwrap();
    assert_eq!(queues.len(), 2);
    assert!(queues.is_ready(0));
    assert!(!queues.is_ready(1));
    assert_eq!(queues.max_size(0), Some(SIZE));
    assert_eq!(queues.max_size(1), Some(SIZE));

    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert!(queues.drain(0, |_| Ok(Completion::Used(4))).unwrap());
    assert_eq!(used_idx(&memory), 1);
    assert_eq!(used_idx_at(&memory, USED2), 0);
}

#[test]
fn drain_and_complete_reject_an_unknown_queue_index() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    assert_eq!(
        queues.drain(1, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("virtio queue"))
    );
    assert_eq!(
        queues.complete(1, 0, 4),
        Err(DeviceError::NeedsReset("virtio queue"))
    );
}

#[test]
fn drain_and_complete_reject_a_not_ready_queue() {
    let memory = memory();
    let mut queues = VirtQueues::prepare(
        vec![Queue::new(SIZE).unwrap()],
        &[SIZE],
        false,
        false,
        Arc::clone(&memory),
    )
    .unwrap();
    assert_eq!(
        queues.drain(0, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("virtio queue"))
    );
    assert_eq!(
        queues.complete(0, 0, 4),
        Err(DeviceError::NeedsReset("virtio queue"))
    );
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn queue_errors_name_their_cause() {
    assert_eq!(
        DeviceError::from(QueueError::Invalid),
        DeviceError::NeedsReset("virtio queue state")
    );
    assert_eq!(
        QueueError::Count {
            expected: 2,
            actual: 1
        }
        .to_string(),
        "queue count is 1, expected 2"
    );
    assert_eq!(
        QueueError::MaxSize {
            expected: SIZE,
            actual: 4
        }
        .to_string(),
        "queue maximum size is 4, expected 8"
    );
}

#[test]
fn queue_state_restores_valid_rings_and_rejects_a_wrong_slot_count() {
    let memory = memory();
    let state = prepared(ready_queue(), false, false, &memory)
        .state(0)
        .unwrap();
    let restored =
        VirtQueues::restore(&[state], &[SIZE], false, false, Arc::clone(&memory)).unwrap();
    assert_eq!(restored.state(0), Some(state));
    assert_eq!(
        VirtQueues::restore(&[], &[SIZE], false, false, Arc::clone(&memory)).err(),
        Some(SnapshotError::Invalid("virtio queue count"))
    );
}

#[test]
fn queue_save_rejects_a_deferred_head_until_completion() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    assert_eq!(queues.save().unwrap(), [queues.state(0).unwrap()]);

    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
    assert_eq!(
        queues.save().err(),
        Some(SnapshotError::Busy("incomplete virtio chains"))
    );
    assert!(queues.complete(0, 0, 4).unwrap());
    assert_eq!(queues.save().unwrap()[0].next_used, 1);
}

#[test]
fn pop_takes_one_chain_and_tracks_its_deferred_completion() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for head in 0..2 {
        write_desc(&memory, head, DATA, 4, 0, 0);
        add_chain(&memory, head);
    }
    write_u16(&memory, GuestAddress(USED), 1); // Previously suppressed guest kicks.
    let chain = queues.pop(0).unwrap().unwrap();
    assert_eq!(chain.head_index(), 0);
    assert_eq!(chain.map(|descriptor| descriptor.len()).sum::<u32>(), 4);
    assert_eq!(queues.size(0), Some(SIZE));
    assert!(queues.save().is_err());
    assert!(matches!(
        VirtQueues::restore(
            &[queues.state(0).unwrap()],
            &[SIZE],
            false,
            false,
            memory.clone()
        ),
        Err(SnapshotError::Invalid(_))
    ));
    assert_eq!(queues.size(1), None);
    assert_eq!(queues.state(0).unwrap().next_avail, 1);
    assert_eq!(used_flags(&memory), 0);
    assert_eq!(used_idx(&memory), 0);
    assert!(queues.complete(0, 0, 4).unwrap());
    assert_eq!(used_entry(&memory, 0), (0, 4));
    assert!(queues.complete(0, 0, 4).is_err());
    assert_eq!(queues.pop(0).unwrap().unwrap().head_index(), 1);
    assert!(queues.pop(0).unwrap().is_none());
    assert!(queues.complete(0, 1, 4).unwrap());
    assert_eq!(used_idx(&memory), 2);
}

#[test]
fn pop_refreshes_event_idx_kick_threshold_after_consumption_and_empty_calls() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), true, false, &memory);
    assert!(queues.pop(0).unwrap().is_none());
    assert_eq!(avail_event(&memory), 0);
    for head in 0..2 {
        write_desc(&memory, head, DATA, 4, 0, 0);
        add_chain(&memory, head);
    }
    assert_eq!(queues.pop(0).unwrap().unwrap().head_index(), 0);
    assert_eq!(avail_event(&memory), 1);
    assert_eq!(queues.pop(0).unwrap().unwrap().head_index(), 1);
    assert_eq!(avail_event(&memory), 2);
    assert!(queues.pop(0).unwrap().is_none());
    assert_eq!(avail_event(&memory), 2);
    write_desc(&memory, 2, DATA, 4, 0, 0);
    add_chain(&memory, 2);
    assert_eq!(queues.pop(0).unwrap().unwrap().head_index(), 2);
    assert_eq!(avail_event(&memory), 3);
}

#[test]
fn pop_rejects_unready_unknown_and_malformed_queues() {
    let memory = memory();
    let mut queues = prepared(Queue::new(SIZE).unwrap(), false, false, &memory);
    assert!(matches!(queues.pop(0), Err(DeviceError::NeedsReset(_))));
    assert!(matches!(queues.pop(1), Err(DeviceError::NeedsReset(_))));
    for (head, flags, next) in [
        (SIZE, 0, 0),
        (0, NEXT, SIZE),
        (0, NEXT, 0),
        (0, INDIRECT_FLAG, 0),
    ] {
        let mut queues = prepared(ready_queue(), false, false, &memory);
        write_u16(&memory, GuestAddress(AVAIL + 2), 0);
        write_desc(&memory, 0, DATA, 4, flags, next);
        add_chain(&memory, head);
        assert!(matches!(queues.pop(0), Err(DeviceError::NeedsReset(_))));
    }
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_u16(&memory, GuestAddress(AVAIL + 2), SIZE + 1);
    assert!(matches!(queues.pop(0), Err(DeviceError::NeedsReset(_))));
}

#[test]
fn pop_rejects_a_duplicate_outstanding_head() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert_eq!(queues.pop(0).unwrap().unwrap().head_index(), 0);
    add_chain(&memory, 0);
    assert!(matches!(
        queues.pop(0),
        Err(DeviceError::NeedsReset("virtio deferred chain"))
    ));
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn queue_snapshot_preserves_progress_and_pending_work_in_copied_ram() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for head in 0..2 {
        write_desc(&memory, head, DATA, 4, 0, 0);
        add_chain(&memory, head);
    }
    assert_eq!(queues.pop(0).unwrap().unwrap().head_index(), 0);
    assert!(queues.complete(0, 0, 4).unwrap());
    let states = queues.save().unwrap();
    let copy = self::memory();
    let mut bytes = vec![0; 0x10000];
    memory.read_slice(&mut bytes, GuestAddress(0)).unwrap();
    copy.write_slice(&bytes, GuestAddress(0)).unwrap();
    drop(queues);
    drop(memory);
    let mut restored = VirtQueues::restore(&states, &[SIZE], false, false, copy.clone()).unwrap();
    assert_eq!(restored.pop(0).unwrap().unwrap().head_index(), 1);
    assert!(restored.complete(0, 1, 4).unwrap());
    assert!(restored.pop(0).unwrap().is_none());
    assert_eq!(used_idx(&copy), 2);
    assert_eq!(used_entry(&copy, 1), (1, 4));
}

#[test]
fn queue_snapshot_rejects_tampered_cursors_features_and_ring_layout() {
    let memory = memory();
    let queues = prepared(ready_queue(), false, false, &memory);
    let state = queues.save().unwrap()[0];
    let mut invalid = Vec::new();
    let mut changed = state;
    changed.max_size = 4;
    invalid.push(changed);
    let mut changed = state;
    changed.size = 0;
    invalid.push(changed);
    for size in [3, SIZE * 2] {
        let mut changed = state;
        changed.size = size;
        invalid.push(changed);
    }
    let mut changed = state;
    changed.next_avail = 1;
    invalid.push(changed);
    let mut changed = state;
    changed.next_used = 1;
    invalid.push(changed);
    let mut changed = state;
    changed.next_avail = 1;
    changed.next_used = 1;
    invalid.push(changed);
    let mut changed = state;
    changed.event_idx_enabled = true;
    invalid.push(changed);
    let mut changed = state;
    changed.desc_table += 1;
    invalid.push(changed);
    for address in [0x10000, 0xfff0] {
        let mut changed = state;
        changed.desc_table = address;
        invalid.push(changed);
    }
    for address in [0, AVAIL + 1] {
        let mut changed = state;
        changed.avail_ring = address;
        invalid.push(changed);
    }
    let mut changed = state;
    changed.used_ring += 1;
    invalid.push(changed);
    let mut changed = state;
    changed.avail_ring = 0x10000;
    invalid.push(changed);
    let mut changed = state;
    changed.used_ring = 0x10000;
    invalid.push(changed);
    for state in invalid {
        assert!(VirtQueues::restore(&[state], &[SIZE], false, false, memory.clone()).is_err());
        assert_eq!(used_idx(&memory), 0);
    }
    for available in [SIZE + 1, u16::MAX] {
        write_u16(&memory, GuestAddress(AVAIL + 2), available);
        assert!(VirtQueues::restore(&[state], &[SIZE], false, false, memory.clone()).is_err());
    }
    write_u16(&memory, GuestAddress(AVAIL + 2), SIZE);
    let mut restored =
        VirtQueues::restore(&[state], &[SIZE], false, false, memory.clone()).unwrap();
    for head in 0..SIZE {
        write_desc(&memory, head, DATA, 4, 0, 0);
        write_u16(&memory, GuestAddress(AVAIL + 4 + 2 * u64::from(head)), head);
    }
    assert!(restored.drain(0, |_| Ok(Completion::Used(4))).unwrap());
    assert_eq!(used_idx(&memory), SIZE);
}

#[test]
fn queue_snapshots_preserve_wraparound_and_unready_slots() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_next_avail(u16::MAX);
    queue.set_next_used(u16::MAX);
    write_u16(&memory, GuestAddress(AVAIL + 2), u16::MAX);
    write_u16(&memory, GuestAddress(USED + 2), u16::MAX);
    let mut queues = VirtQueues::prepare(
        vec![queue, Queue::new(SIZE).unwrap()],
        &[SIZE, SIZE],
        false,
        false,
        memory.clone(),
    )
    .unwrap();
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert_eq!(queues.pop(0).unwrap().unwrap().head_index(), 0);
    assert!(queues.complete(0, 0, 4).unwrap());
    let states = queues.save().unwrap();
    assert_eq!(states[0].next_avail, 0);
    assert_eq!(states[0].next_used, 0);
    let restored = VirtQueues::restore(&states, &[SIZE, SIZE], false, false, memory).unwrap();
    assert_eq!(restored.save().unwrap(), states);
    assert!(!restored.is_ready(1));
}

#[test]
fn queue_snapshot_rejects_consumption_that_failed_without_a_used_entry() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert!(
        queues
            .drain(0, |_| Err(DeviceError::Fatal("request failed")))
            .is_err()
    );
    assert_eq!(
        queues.save(),
        Err(SnapshotError::Busy("incomplete virtio chains"))
    );
}

#[test]
fn retry_keeps_the_head_available_and_restores_notifications() {
    for event_idx in [false, true] {
        let memory = memory();
        let mut queues = prepared(ready_queue(), event_idx, false, &memory);
        write_desc(&memory, 0, DATA, 4, 0, 0);
        add_chain(&memory, 0);
        let mut calls = 0;
        assert!(
            !queues
                .drain(0, |chain| {
                    calls += 1;
                    assert_eq!(chain.head_index(), 0);
                    Ok(Completion::Retry)
                })
                .unwrap()
        );
        assert_eq!(
            calls, 1,
            "retry must return instead of spinning on the same head"
        );
        assert_eq!(queues.state(0).unwrap().next_avail, 0);
        assert_eq!(used_idx(&memory), 0);
        assert_eq!(used_flags(&memory), 0);
        if event_idx {
            assert_eq!(avail_event(&memory), queues.state(0).unwrap().next_avail);
        }
        assert!(
            queues
                .drain(0, |chain| {
                    assert_eq!(chain.head_index(), 0);
                    Ok(Completion::Used(4))
                })
                .unwrap()
        );
        assert_eq!(used_idx(&memory), 1);
        assert_eq!(used_entry(&memory, 0), (0, 4));
    }
}

#[test]
fn retry_preserves_the_interrupt_for_prior_completions_in_the_batch() {
    for event_idx in [false, true] {
        let memory = memory();
        let mut queues = prepared(ready_queue(), event_idx, false, &memory);
        for head in 0..2 {
            write_desc(&memory, head, DATA, 4, 0, 0);
            add_chain(&memory, head);
        }
        assert!(
            queues
                .drain(0, |chain| {
                    Ok(if chain.head_index() == 0 {
                        Completion::Used(4)
                    } else {
                        Completion::Retry
                    })
                })
                .unwrap()
        );
        assert_eq!(used_idx(&memory), 1);
        assert_eq!(queues.state(0).unwrap().next_avail, 1);
        assert_eq!(used_flags(&memory), 0);
        if event_idx {
            assert_eq!(avail_event(&memory), queues.state(0).unwrap().next_avail);
        }
        if event_idx {
            set_used_event(&memory, 1);
        }
        assert!(
            queues
                .drain(0, |chain| {
                    assert_eq!(chain.head_index(), 1);
                    Ok(Completion::Used(8))
                })
                .unwrap()
        );
        assert_eq!(used_idx(&memory), 2);
        assert_eq!(used_entry(&memory, 1), (1, 8));
    }
}

#[test]
fn snapshot_round_trip_preserves_progress_and_notifications() {
    for event_idx in [false, true] {
        let memory = memory();
        let mut queues = prepared(ready_queue(), event_idx, false, &memory);
        for head in 0..2 {
            write_desc(&memory, head, DATA, 4, 0, 0);
            add_chain(&memory, head);
        }
        assert!(
            queues
                .drain(0, |chain| Ok(if chain.head_index() == 0 {
                    Completion::Used(4)
                } else {
                    Completion::Retry
                }))
                .unwrap()
        );
        let states = queues.save().unwrap();
        let mut restored =
            VirtQueues::restore(&states, &[SIZE], event_idx, false, memory.clone()).unwrap();
        assert_eq!(restored.state(0), Some(states[0]));
        if event_idx {
            set_used_event(&memory, 1);
        }
        assert!(
            restored
                .drain(0, |chain| {
                    assert_eq!(chain.head_index(), 1);
                    Ok(Completion::Used(8))
                })
                .unwrap()
        );
        assert_eq!(used_idx(&memory), 2);
        assert_eq!(used_entry(&memory, 1), (1, 8));
    }
}

#[test]
fn snapshot_restores_indices_across_wraparound() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_next_avail(u16::MAX);
    queue.set_next_used(u16::MAX);
    write_u16(&memory, GuestAddress(AVAIL + 2), u16::MAX);
    write_u16(&memory, GuestAddress(USED + 2), u16::MAX);
    set_used_event(&memory, u16::MAX);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    let queues = prepared(queue, true, false, &memory);
    let mut restored = VirtQueues::restore(
        &queues.save().unwrap(),
        &[SIZE],
        true,
        false,
        memory.clone(),
    )
    .unwrap();
    assert!(restored.drain(0, |_| Ok(Completion::Used(4))).unwrap());
    assert_eq!(used_idx(&memory), 0);
    assert_eq!(restored.state(0).unwrap().next_avail, 0);
}

#[test]
fn event_idx_ignores_no_interrupt_for_both_completion_paths() {
    for deferred in [false, true] {
        let memory = memory();
        let mut queues = prepared(ready_queue(), true, false, &memory);
        write_u16(&memory, GuestAddress(AVAIL), 1);
        set_used_event(&memory, 1);
        for head in 0..2 {
            write_desc(&memory, head, DATA, 4, 0, 0);
            add_chain(&memory, head);
            let notify = if deferred {
                assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
                queues.complete(0, head, 4).unwrap()
            } else {
                queues.drain(0, |_| Ok(Completion::Used(4))).unwrap()
            };
            assert_eq!(notify, head == 1);
        }
        assert_eq!(used_idx(&memory), 2);
    }
}

#[test]
fn pop_reports_configured_size_and_accepts_negotiated_indirect_chains() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.try_set_size(SIZE / 2).unwrap();
    let mut queues = prepared(queue, false, true, &memory);
    assert_eq!(queues.size(0), Some(SIZE / 2));
    assert_eq!(queues.max_size(0), Some(SIZE));
    memory
        .write_obj(Descriptor::new(DATA, 4, 0, 0), GuestAddress(INDIRECT))
        .unwrap();
    write_desc(&memory, 0, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);
    let chain = queues.pop(0).unwrap().unwrap();
    assert_eq!(chain.head_index(), 0);
    assert_eq!(chain.map(|d| d.len()).sum::<u32>(), 4);
    assert!(queues.complete(0, 0, 4).unwrap());
    assert_eq!(used_entry(&memory, 0), (0, 4));
}

#[test]
fn restore_applies_the_supplied_indirect_feature() {
    for indirect in [false, true] {
        let memory = memory();
        let queues = prepared(ready_queue(), false, indirect, &memory);
        memory
            .write_obj(Descriptor::new(DATA, 4, 0, 0), GuestAddress(INDIRECT))
            .unwrap();
        write_desc(&memory, 0, INDIRECT, 16, INDIRECT_FLAG, 0);
        add_chain(&memory, 0);
        let mut restored = VirtQueues::restore(
            &queues.save().unwrap(),
            &[SIZE],
            false,
            indirect,
            memory.clone(),
        )
        .unwrap();
        let result = restored.drain(0, |chain| {
            Ok(Completion::Used(chain.map(|d| d.len()).sum()))
        });
        if indirect {
            assert_eq!(result, Ok(true));
            assert_eq!(used_entry(&memory, 0), (0, 4));
        } else {
            assert_eq!(result, Err(DeviceError::NeedsReset("indirect descriptor")));
            assert_eq!(used_idx(&memory), 0);
        }
    }
}

#[test]
fn retry_preserves_deferred_heads_and_wraps_the_available_cursor() {
    for event_idx in [false, true] {
        let memory = memory();
        let mut queue = ready_queue();
        queue.set_next_avail(u16::MAX - 1);
        queue.set_next_used(u16::MAX - 1);
        write_u16(&memory, GuestAddress(AVAIL + 2), u16::MAX - 1);
        write_u16(&memory, GuestAddress(USED + 2), u16::MAX - 1);
        set_used_event(&memory, u16::MAX - 1);
        for head in 0..2 {
            write_desc(&memory, head, DATA, 4, 0, 0);
            add_chain(&memory, head);
        }
        let mut queues = prepared(queue, event_idx, false, &memory);
        assert!(
            !queues
                .drain(0, |chain| Ok(if chain.head_index() == 0 {
                    Completion::Deferred
                } else {
                    Completion::Retry
                }))
                .unwrap()
        );
        assert_eq!(queues.state(0).unwrap().next_avail, u16::MAX);
        assert_eq!(used_idx(&memory), u16::MAX - 1);
        assert_eq!(used_flags(&memory), 0);
        if event_idx {
            assert_eq!(avail_event(&memory), u16::MAX);
        }
        assert!(queues.save().is_err());
        assert!(queues.complete(0, 0, 4).unwrap());
        assert!(queues.complete(0, 1, 4).is_err());
        let states = queues.save().unwrap();
        assert_eq!(states[0].next_avail, u16::MAX);
        assert_eq!(queues.pop(0).unwrap().unwrap().head_index(), 1);
        let _ = queues.complete(0, 1, 4).unwrap();
        assert_eq!(used_idx(&memory), 0);
        assert_eq!(queues.save().unwrap()[0].next_avail, 0);
    }
}
