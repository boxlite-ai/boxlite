// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Queue facade tests: dense validation, notification drain, deferred
//! completion and the snapshot stubs.

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
            Arc::clone(&memory),
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
            Arc::clone(&memory),
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
        VirtQueues::prepare(vec![queue], &[SIZE], false, false, Arc::clone(&memory),).err(),
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
        VirtQueues::prepare(vec![queue], &[SIZE], false, false, Arc::clone(&memory),).err(),
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
fn one_callback_completes_every_available_chain() {
    for event_idx in [false, true] {
        let memory = memory();
        let mut queues = prepared(ready_queue(), event_idx, false, &memory);
        for head in [0u16, 2, 4] {
            write_desc(&memory, head, DATA, 4, NEXT, head + 1);
            write_desc(&memory, head + 1, DATA + 4, 8, 0, 0);
            add_chain(&memory, head);
        }
        let mut heads = Vec::new();
        queues
            .drain(0, |chain| {
                heads.push(chain.head_index());
                Ok(Completion::Used(chain.map(|desc| desc.len()).sum()))
            })
            .unwrap();
        assert_eq!(heads, [0, 2, 4]);
        assert_eq!(used_idx(&memory), 3);
        for (used, head) in [0u16, 2, 4].into_iter().enumerate() {
            assert_eq!(used_entry(&memory, used as u16), (u32::from(head), 12));
        }
        assert_eq!(used_flags(&memory), 0);
        assert!(!queues.drain(0, |_| panic!("empty ring")).unwrap());
    }
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
fn event_idx_suppresses_until_the_completion_crosses_the_threshold() {
    // Below the announced event index: a whole drain stays silent.
    let below = memory();
    let mut queues = prepared(ready_queue(), true, false, &below);
    set_used_event(&below, 100);
    for index in 0..6 {
        write_desc(&below, index, DATA, 4, 0, 0);
        add_chain(&below, index);
    }
    assert!(!queues.drain(0, |_| Ok(Completion::Used(4))).unwrap());
    assert_eq!(used_idx(&below), 6);

    // Crossing it interrupts on the same call.
    let crossed = memory();
    let mut queues = prepared(ready_queue(), true, false, &crossed);
    set_used_event(&crossed, 5);
    for index in 0..6 {
        write_desc(&crossed, index, DATA, 4, 0, 0);
        add_chain(&crossed, index);
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
fn concurrent_refill_is_drained_in_the_same_call() {
    for event_idx in [false, true] {
        let memory = memory();
        let mut queues = prepared(ready_queue(), event_idx, false, &memory);
        write_desc(&memory, 0, DATA, 4, 0, 0);
        add_chain(&memory, 0);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (refilled_tx, refilled_rx) = std::sync::mpsc::channel();
        let mut heads = Vec::new();
        std::thread::scope(|scope| {
            let memory = &memory;
            scope.spawn(move || {
                entered_rx.recv().unwrap();
                write_desc(memory, 1, DATA, 8, 0, 0);
                add_chain(memory, 1);
                refilled_tx.send(()).unwrap();
            });
            queues
                .drain(0, |chain| {
                    heads.push(chain.head_index());
                    if chain.head_index() == 0 {
                        entered_tx.send(()).unwrap();
                        refilled_rx.recv().unwrap();
                    }
                    Ok(Completion::Used(4))
                })
                .unwrap();
        });
        // The refilled chain became available while the first chain ran, so
        // the drain's notification recheck takes it in the same call.
        assert_eq!(heads, [0, 1]);
        assert_eq!(used_idx(&memory), 2);
    }
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
fn used_entries_preserve_completion_order_across_inline_and_deferred_chains() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }

    // One drain: heads 0 and 2 complete inline while head 1 is deferred.
    assert!(
        queues
            .drain(0, |chain| {
                if chain.head_index() == 1 {
                    Ok(Completion::Deferred)
                } else {
                    Ok(Completion::Used(6))
                }
            })
            .unwrap()
    );
    let state = queues.state(0).unwrap();
    assert_eq!(state.next_avail, 3);
    assert_eq!(state.next_used, 2);
    assert_eq!(used_entry(&memory, 0), (0, 6));
    assert_eq!(used_entry(&memory, 1), (2, 6));

    assert!(queues.complete(0, 1, 8).unwrap());
    let state = queues.state(0).unwrap();
    assert_eq!(state.next_used, 3);
    assert_eq!(used_idx(&memory), 3);
    assert_eq!(used_entry(&memory, 2), (1, 8));
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
    for _ in 0..2 {
        assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
    }
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
    for _ in 0..3 {
        assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
    }
    assert!(!queues.complete(0, 0, 4).unwrap());
    assert!(!queues.complete(0, 1, 4).unwrap());
    assert!(queues.complete(0, 2, 4).unwrap());
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
    for _ in 0..3 {
        assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
    }

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
    // One drain takes both avail entries, so the second defers the same head.
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
fn restore_reports_snapshots_unsupported() {
    let memory = memory();
    let state = prepared(ready_queue(), false, false, &memory)
        .state(0)
        .unwrap();
    assert_eq!(
        VirtQueues::restore(&[state], &[SIZE], false, false, Arc::clone(&memory)).err(),
        Some(SnapshotError::Unsupported)
    );
    assert_eq!(
        VirtQueues::restore(&[], &[SIZE], false, false, Arc::clone(&memory)).err(),
        Some(SnapshotError::Unsupported)
    );
}

#[test]
fn save_reports_snapshots_unsupported() {
    let memory = memory();
    let mut queues = prepared(ready_queue(), false, false, &memory);
    assert_eq!(queues.save().err(), Some(SnapshotError::Unsupported));

    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert!(!queues.drain(0, |_| Ok(Completion::Deferred)).unwrap());
    assert_eq!(queues.save().err(), Some(SnapshotError::Unsupported));
}

#[test]
fn control_ranges_use_actual_sizes_include_events_and_skip_unready_slots() {
    let memory = memory();
    let mut small = ready_queue_at(DESC2, AVAIL2, USED2);
    small.try_set_size(4).unwrap();
    let queues = VirtQueues::prepare(
        vec![ready_queue(), Queue::new(SIZE).unwrap(), small],
        &[SIZE; 3],
        false,
        false,
        Arc::clone(&memory),
    )
    .unwrap();
    assert_eq!(
        queues.control_ranges().collect::<Vec<_>>(),
        [
            (GuestAddress(DESC), 16 * SIZE as usize),
            (GuestAddress(AVAIL), 6 + 2 * SIZE as usize),
            (GuestAddress(USED), 6 + 8 * SIZE as usize),
            (GuestAddress(DESC2), 16 * 4),
            (GuestAddress(AVAIL2), 6 + 2 * 4),
            (GuestAddress(USED2), 6 + 8 * 4),
        ]
    );
}

#[test]
fn failed_chain_processing_never_publishes_used() {
    for failure in [
        DeviceError::NeedsReset("request"),
        DeviceError::Fatal("backend"),
    ] {
        let memory = memory();
        let mut queues = prepared(ready_queue(), false, false, &memory);
        for head in 0..2 {
            write_desc(&memory, head, DATA, 4, 0, 0);
            add_chain(&memory, head);
        }
        assert_eq!(queues.drain(0, |_| Err(failure)), Err(failure));
        assert_eq!(used_idx(&memory), 0);
    }
}
