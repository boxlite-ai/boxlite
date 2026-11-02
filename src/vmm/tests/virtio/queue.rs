// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Queue adapter tests: dense validation, state restore, notification drain and
//! deferred completion.

use virtio_queue::{Queue, QueueT, desc::split::Descriptor};
use vm_memory::{Address, Bytes, GuestAddress};

use crate::{
    memory::GuestMemoryMmap,
    virtio::{
        DeviceError,
        queue::{self, Completion, QueueError, VIRTIO_F_EVENT_IDX, VIRTIO_F_INDIRECT_DESC},
    },
};

const SIZE: u16 = 8;
const DESC: u64 = 0x1000;
const DATA: u64 = 0x7000;
const AVAIL: u64 = 0x8000;
const INDIRECT: u64 = 0x9000;
const USED: u64 = 0xa000;
const NEXT: u16 = 1;
const INDIRECT_FLAG: u16 = 4;

fn memory() -> GuestMemoryMmap {
    GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap()
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
    let mut queue = Queue::new(SIZE).unwrap();
    queue.try_set_size(SIZE).unwrap();
    queue
        .try_set_desc_table_address(GuestAddress(DESC))
        .unwrap();
    queue
        .try_set_avail_ring_address(GuestAddress(AVAIL))
        .unwrap();
    queue.try_set_used_ring_address(GuestAddress(USED)).unwrap();
    queue.set_ready(true);
    queue
}

fn write_desc(memory: &GuestMemoryMmap, index: u16, addr: u64, len: u32, flags: u16, next: u16) {
    let address = GuestAddress(DESC + u64::from(index) * 16);
    memory
        .write_obj(Descriptor::new(addr, len, flags, next), address)
        .unwrap();
}

fn add_chain(memory: &GuestMemoryMmap, head: u16) {
    let index = read_u16(memory, GuestAddress(AVAIL + 2));
    let slot = GuestAddress(AVAIL + 4 + 2 * u64::from(index % SIZE));
    write_u16(memory, slot, head);
    write_u16(memory, GuestAddress(AVAIL + 2), index.wrapping_add(1));
}

fn used_idx(memory: &GuestMemoryMmap) -> u16 {
    read_u16(memory, GuestAddress(USED + 2))
}

fn used_entry(memory: &GuestMemoryMmap, index: u16) -> (u32, u32) {
    let address = GuestAddress(USED + 4 + 8 * u64::from(index % SIZE));
    (
        read_u32(memory, address),
        read_u32(memory, address.unchecked_add(4)),
    )
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
fn prepare_all_accepts_a_dense_ready_queue() {
    let memory = memory();
    let mut queues = vec![ready_queue()];
    queue::prepare_all(&mut queues, &[SIZE], true, &memory).unwrap();
    assert!(queues[0].event_idx_enabled());
    assert_eq!(queues[0].size(), SIZE);
}

#[test]
fn prepare_all_requires_one_queue_per_slot() {
    let memory = memory();
    let mut queues = vec![ready_queue()];
    assert_eq!(
        queue::prepare_all(&mut queues, &[SIZE, SIZE], false, &memory),
        Err(QueueError::Count {
            expected: 2,
            actual: 1
        })
    );
}

#[test]
fn prepare_all_checks_each_slot_max_size() {
    let memory = memory();
    let mut queues = vec![Queue::new(4).unwrap()];
    assert_eq!(
        queue::prepare_all(&mut queues, &[SIZE], false, &memory),
        Err(QueueError::MaxSize {
            expected: SIZE,
            actual: 4
        })
    );
}

#[test]
fn prepare_all_keeps_unready_queues_but_applies_event_idx() {
    let memory = memory();
    let mut queues = vec![Queue::new(SIZE).unwrap()];
    queue::prepare_all(&mut queues, &[SIZE], true, &memory).unwrap();
    assert!(!queues[0].ready());
    assert!(queues[0].event_idx_enabled());
}

#[test]
fn prepare_all_rejects_a_zero_avail_ring() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.try_set_avail_ring_address(GuestAddress(0)).unwrap();
    let mut queues = vec![queue];
    assert_eq!(
        queue::prepare_all(&mut queues, &[SIZE], false, &memory),
        Err(QueueError::Invalid)
    );
}

#[test]
fn prepare_all_rejects_rings_outside_memory() {
    let memory = memory();
    let mut queue = ready_queue();
    queue
        .try_set_used_ring_address(GuestAddress(0x1_0000))
        .unwrap();
    let mut queues = vec![queue];
    assert_eq!(
        queue::prepare_all(&mut queues, &[SIZE], false, &memory),
        Err(QueueError::Memory)
    );
}

#[test]
fn queue_state_round_trips_every_field() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_next_avail(9);
    queue.set_next_used(10);
    queue.set_event_idx(true);
    let states = queue::save(std::slice::from_ref(&queue));
    let restored = queue::restore(&states, &[SIZE], true, &memory).unwrap();
    assert_eq!(restored[0].state(), states[0]);
    assert_eq!(restored[0].next_avail(), 9);
    assert_eq!(restored[0].next_used(), 10);
    assert!(restored[0].event_idx_enabled());
    assert_eq!(restored[0].desc_table(), DESC);
    assert_eq!(restored[0].avail_ring(), AVAIL);
    assert_eq!(restored[0].used_ring(), USED);
}

#[test]
fn restore_rejects_a_different_max_size() {
    let memory = memory();
    let states = queue::save(&[ready_queue()]);
    assert_eq!(
        queue::restore(&states, &[4], false, &memory),
        Err(QueueError::MaxSize {
            expected: 4,
            actual: SIZE
        })
    );
}

#[test]
fn restore_rejects_invalid_states() {
    let memory = memory();
    let saved = queue::save(&[ready_queue()]);
    let mut state = saved[0];

    state.size = 0;
    assert_eq!(
        queue::restore(&[state], &[SIZE], false, &memory),
        Err(QueueError::Invalid)
    );
    state = saved[0];
    state.size = 15;
    assert_eq!(
        queue::restore(&[state], &[SIZE], false, &memory),
        Err(QueueError::Invalid)
    );
    state = saved[0];
    state.desc_table = 0xf;
    assert_eq!(
        queue::restore(&[state], &[SIZE], false, &memory),
        Err(QueueError::Invalid)
    );
    state = saved[0];
    state.avail_ring = 0x1;
    assert_eq!(
        queue::restore(&[state], &[SIZE], false, &memory),
        Err(QueueError::Invalid)
    );
    state = saved[0];
    state.used_ring = 0x3;
    assert_eq!(
        queue::restore(&[state], &[SIZE], false, &memory),
        Err(QueueError::Invalid)
    );
    state = saved[0];
    state.max_size = 0;
    assert_eq!(
        queue::restore(&[state], &[0], false, &memory),
        Err(QueueError::Invalid)
    );
}

#[test]
fn restore_rejects_ready_rings_outside_memory() {
    let memory = memory();
    let saved = queue::save(&[ready_queue()]);
    let mut state = saved[0];
    state.used_ring = 0x1_0000;
    assert_eq!(
        queue::restore(&[state], &[SIZE], false, &memory),
        Err(QueueError::Memory)
    );
    state.ready = false;
    assert!(queue::restore(&[state], &[SIZE], false, &memory).is_ok());
}

#[test]
fn restore_reapplies_negotiated_event_idx() {
    let memory = memory();
    let mut state = queue::save(&[ready_queue()])[0];
    state.event_idx_enabled = true;
    let restored = queue::restore(&[state], &[SIZE], false, &memory).unwrap();
    assert!(!restored[0].event_idx_enabled());
    let restored = queue::restore(&[state], &[SIZE], true, &memory).unwrap();
    assert!(restored[0].event_idx_enabled());
}

#[test]
fn prepare_all_reapplies_event_idx_after_reset() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_event_idx(true);
    queue.reset();
    assert!(!queue.event_idx_enabled());
    let mut queues = vec![queue];
    queue::prepare_all(&mut queues, &[SIZE], true, &memory).unwrap();
    assert!(queues[0].event_idx_enabled());
}

#[test]
fn save_after_a_notification_decision_round_trips_state() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert!(queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))).unwrap());
    let states = queue::save(std::slice::from_ref(&queue));
    let restored = queue::restore(&states, &[SIZE], false, &memory).unwrap();
    assert_eq!(restored[0].state(), states[0]);
}

#[test]
fn drain_completes_every_available_chain() {
    let memory = memory();
    let mut queue = ready_queue();
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    let mut heads = Vec::new();
    let notify = queue::drain(&mut queue, &memory, false, |chain| {
        heads.push(chain.head_index());
        Ok(Completion::Used(
            chain.map(|descriptor| descriptor.len()).sum(),
        ))
    })
    .unwrap();
    assert!(notify);
    assert_eq!(heads, vec![0, 1, 2]);
    assert_eq!(queue.next_avail(), 3);
    assert_eq!(queue.next_used(), 3);
    assert_eq!(used_idx(&memory), 3);
    assert_eq!(used_entry(&memory, 0), (0, 4));
    assert_eq!(used_entry(&memory, 1), (1, 4));
    assert_eq!(used_entry(&memory, 2), (2, 4));
}

#[test]
fn empty_drain_does_not_interrupt() {
    for event_idx in [false, true] {
        let memory = memory();
        let mut queue = ready_queue();
        queue.set_event_idx(event_idx);
        let notify = queue::drain(&mut queue, &memory, false, |_| panic!("no chain")).unwrap();
        assert!(!notify);
        assert_eq!(used_idx(&memory), 0);
        assert_eq!(used_flags(&memory), 0);
        assert_eq!(avail_event(&memory), 0);
    }
}

#[test]
fn without_event_idx_one_interrupt_per_batch() {
    let memory = memory();
    let mut queue = ready_queue();
    for index in 0..4 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))).unwrap());
    assert!(!queue::drain(&mut queue, &memory, false, |_| panic!("empty")).unwrap());
    assert_eq!(used_flags(&memory), 0);
}

#[test]
fn event_idx_suppresses_below_threshold() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_event_idx(true);
    set_used_event(&memory, 5);
    for index in 0..2 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(!queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))).unwrap());
    for index in 2..6 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))).unwrap());
}

#[test]
fn event_idx_wraps_used_indices() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_event_idx(true);
    set_used_event(&memory, u16::MAX - 3);
    queue.set_next_used(u16::MAX - 3);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    assert!(queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))).unwrap());
    assert!(!queue::drain(&mut queue, &memory, false, |_| panic!("empty")).unwrap());
}

#[test]
fn drain_keeps_work_that_arrives_while_disabled() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    let mut count = 0;
    let notify = queue::drain(&mut queue, &memory, false, |_| {
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

    queue.disable_notification(&memory).unwrap();
    add_chain(&memory, 2);
    assert!(queue.enable_notification(&memory).unwrap());
}

#[test]
fn drain_rejects_indirect_descriptors_when_not_negotiated() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);
    let mut completed = false;
    let result = queue::drain(&mut queue, &memory, false, |_| {
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
    let mut queue = ready_queue();
    write_desc(&memory, 0, DATA, 4, NEXT, 1);
    write_desc(&memory, 1, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);
    assert_eq!(
        queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("indirect descriptor"))
    );
}

#[test]
fn drain_accepts_indirect_descriptors_when_negotiated() {
    let memory = memory();
    let mut queue = ready_queue();
    memory
        .write_obj(Descriptor::new(DATA, 4, 0, 0), GuestAddress(INDIRECT))
        .unwrap();
    write_desc(&memory, 0, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);
    let notify = queue::drain(&mut queue, &memory, true, |chain| {
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
    let mut queue = ready_queue();
    write_u16(&memory, GuestAddress(AVAIL + 2), SIZE + 1);
    assert_eq!(
        queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("virtio queue"))
    );
}

#[test]
fn drain_propagates_completion_errors() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);
    let result = queue::drain(&mut queue, &memory, false, |_| {
        Err(DeviceError::Fatal("backend"))
    });
    assert_eq!(result, Err(DeviceError::Fatal("backend")));
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn drain_rejects_a_malformed_chain() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, DATA, 4, NEXT, 9);
    add_chain(&memory, 0);
    assert_eq!(
        queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("virtio descriptor"))
    );
}

#[test]
fn drain_rejects_a_chain_cycle() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, DATA, 4, NEXT, 0);
    add_chain(&memory, 0);
    assert_eq!(
        queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))),
        Err(DeviceError::NeedsReset("virtio descriptor"))
    );
}

#[test]
fn complete_rejects_an_out_of_range_head() {
    let memory = memory();
    let mut queue = ready_queue();
    assert_eq!(
        queue::complete(&mut queue, &memory, SIZE, 4),
        Err(DeviceError::NeedsReset("virtio queue"))
    );
    assert_eq!(used_idx(&memory), 0);
}

#[test]
fn drain_leaves_a_deferred_chain_for_later_completion() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);

    let notify = queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Deferred)).unwrap();
    assert!(!notify);
    assert_eq!(queue.next_avail(), 1);
    assert_eq!(queue.next_used(), 0);
    assert_eq!(used_idx(&memory), 0);

    assert!(queue::complete(&mut queue, &memory, 0, 4).unwrap());
    assert_eq!(queue.next_used(), 1);
    assert_eq!(used_idx(&memory), 1);
    assert_eq!(used_entry(&memory, 0), (0, 4));
}

#[test]
fn drain_adds_used_entries_in_completion_order_for_a_mixed_batch() {
    let memory = memory();
    let mut queue = ready_queue();
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }

    let notify = queue::drain(&mut queue, &memory, false, |chain| {
        match chain.head_index() {
            0 => Ok(Completion::Used(4)),
            1 => Ok(Completion::Deferred),
            _ => Ok(Completion::Used(6)),
        }
    })
    .unwrap();
    assert!(notify);
    assert_eq!(queue.next_avail(), 3);
    assert_eq!(queue.next_used(), 2);
    assert_eq!(used_entry(&memory, 0), (0, 4));
    assert_eq!(used_entry(&memory, 1), (2, 6));

    assert!(queue::complete(&mut queue, &memory, 1, 8).unwrap());
    assert_eq!(queue.next_used(), 3);
    assert_eq!(used_idx(&memory), 3);
    assert_eq!(used_entry(&memory, 2), (1, 8));
}

#[test]
fn a_deferred_chain_does_not_end_the_notification_drain() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);

    let mut calls = 0;
    let notify = queue::drain(&mut queue, &memory, false, |_| {
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
    assert_eq!(queue.next_avail(), 2);
    assert_eq!(queue.next_used(), 1);
    assert_eq!(used_entry(&memory, 0), (1, 4));
}

#[test]
fn drain_rejects_a_deferred_indirect_chain_when_not_negotiated() {
    let memory = memory();
    let mut queue = ready_queue();
    write_desc(&memory, 0, INDIRECT, 16, INDIRECT_FLAG, 0);
    add_chain(&memory, 0);

    let mut processed = false;
    let result = queue::drain(&mut queue, &memory, false, |_| {
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
    let mut queue = ready_queue();
    queue.set_event_idx(true);
    set_used_event(&memory, 0);
    for index in 0..2 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(!queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Deferred)).unwrap());
    assert!(queue::complete(&mut queue, &memory, 0, 4).unwrap());
    assert!(!queue::complete(&mut queue, &memory, 1, 4).unwrap());
}

#[test]
fn event_idx_crossing_notifies_on_the_completion_that_crosses() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_event_idx(true);
    set_used_event(&memory, 2);
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }
    assert!(!queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Deferred)).unwrap());
    assert!(!queue::complete(&mut queue, &memory, 0, 4).unwrap());
    assert!(!queue::complete(&mut queue, &memory, 1, 4).unwrap());
    assert!(queue::complete(&mut queue, &memory, 2, 4).unwrap());
}

#[test]
fn drain_resolves_event_idx_once_per_batch() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_event_idx(true);
    set_used_event(&memory, 1);
    for index in 0..3 {
        write_desc(&memory, index, DATA, 4, 0, 0);
        add_chain(&memory, index);
    }

    assert!(queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Used(4))).unwrap());
    assert_eq!(used_idx(&memory), 3);
}

#[test]
fn save_after_a_deferred_completion_round_trips_state() {
    let memory = memory();
    let mut queue = ready_queue();
    queue.set_event_idx(true);
    set_used_event(&memory, 0);
    write_desc(&memory, 0, DATA, 4, 0, 0);
    add_chain(&memory, 0);

    assert!(!queue::drain(&mut queue, &memory, false, |_| Ok(Completion::Deferred)).unwrap());
    assert!(queue::complete(&mut queue, &memory, 0, 4).unwrap());

    let states = queue::save(std::slice::from_ref(&queue));
    let restored = queue::restore(&states, &[SIZE], true, &memory).unwrap();
    assert_eq!(restored[0].state(), states[0]);
    assert_eq!(restored[0].next_avail(), 1);
    assert_eq!(restored[0].next_used(), 1);
}
