// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn rx_intake_defers_completion_until_a_packet_arrives() {
    let mut h = Harness::new(vec![]);
    h.tick();
    let state = h
        .device
        .active
        .as_ref()
        .unwrap()
        .ctx
        .queues
        .state(0)
        .unwrap();
    assert_eq!(
        state.next_avail, SIZE,
        "RX buffers must leave the available ring"
    );
    assert_eq!(
        state.next_used, 0,
        "empty RX buffers must remain device-owned"
    );
    h.send(Packet {
        header: guest(REQUEST, 4321, 999),
        payload: vec![],
    });
    assert_eq!(h.next(RST).header.dst_port, 4321);
    assert_eq!(
        h.device
            .active
            .as_ref()
            .unwrap()
            .ctx
            .queues
            .state(0)
            .unwrap()
            .next_used,
        1
    );
    h.tick();
    assert!(h.packets.is_empty(), "a deferred RX head completed twice");
}

#[test]
fn tx_intake_stalls_completion_at_capacity_and_resumes_in_order() {
    let mut h = Harness::new(vec![]);
    h.refill = false;
    for port in 0..SIZE as u32 + backend::MAX_PENDING as u32 {
        h.send(Packet {
            header: guest(REQUEST, port, 999),
            payload: vec![],
        });
    }
    assert_eq!(
        h.device.active.as_ref().unwrap().backend.outgoing.len(),
        backend::MAX_PENDING
    );
    let before = h.tx.avail;
    for port in 0..SIZE {
        let bytes = guest(REQUEST, 1000 + u32::from(port), 999).encode();
        h.tx.submit(&h.memory, &bytes, false, bytes.len());
    }
    let wakes = h.wakes.load(Ordering::Relaxed);
    h.device.on_event(DeviceEvent::QueueKick(1)).unwrap();
    let state = h
        .device
        .active
        .as_ref()
        .unwrap()
        .ctx
        .queues
        .state(1)
        .unwrap();
    assert_eq!(
        state.next_avail,
        before + SIZE,
        "TX intake must drain into device storage"
    );
    assert_eq!(
        state.next_used, before,
        "capacity exhaustion must withhold completion"
    );
    assert!(h.tx.take(&h.memory).is_empty());
    assert_eq!(
        h.wakes.load(Ordering::Relaxed),
        wakes,
        "stalled capacity must not spin"
    );
    h.packets.clear();
    for _ in 0..backend::MAX_PENDING + SIZE as usize {
        h.rx.submit(&h.memory, &[], true, HEADER_LEN);
        h.tick();
    }
    let ports: Vec<_> = h.packets.iter().map(|p| p.header.dst_port).collect();
    let expected: Vec<_> = (SIZE as u32..SIZE as u32 + backend::MAX_PENDING as u32)
        .chain(1000..1000 + SIZE as u32)
        .collect();
    assert_eq!(ports, expected);
    assert_eq!(h.tx.take(&h.memory).len(), SIZE as usize);
}

#[test]
fn reset_discards_deferred_rx_buffers_before_reactivation() {
    let mut h = Harness::new(vec![]);
    h.tick();
    h.device.reset().unwrap();
    h.memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x200000)]).unwrap());
    h.rx = Driver::new(0);
    h.tx = Driver::new(1);
    h.activate();
    h.send(Packet {
        header: guest(REQUEST, 4321, 999),
        payload: vec![],
    });
    assert!(h.packets.is_empty());
    assert_eq!(
        h.device
            .active
            .as_ref()
            .unwrap()
            .ctx
            .queues
            .state(0)
            .unwrap()
            .next_used,
        0
    );
    h.rx.submit(&h.memory, &[], true, HEADER_LEN);
    assert_eq!(h.next(RST).header.dst_port, 4321);
}

#[test]
fn deferred_rx_uses_captured_scatter_buffers() {
    let mut h = Harness::new(vec![]);
    h.refill = false;
    // Publish one chain spanning two descriptors, splitting its header.
    h.rx.avail = 1;
    h.memory
        .write_obj(1u16, GuestAddress(h.rx.base + 0x1002))
        .unwrap();
    h.memory
        .write_obj(20u32, GuestAddress(h.rx.base + 8))
        .unwrap();
    h.memory
        .write_obj(3u16, GuestAddress(h.rx.base + 12))
        .unwrap();
    h.memory
        .write_obj(1u16, GuestAddress(h.rx.base + 14))
        .unwrap();
    h.memory
        .write_obj((HEADER_LEN as u32) - 20, GuestAddress(h.rx.base + 16 + 8))
        .unwrap();
    h.tick();
    // A guest rewriting the table after intake must not redirect our writes.
    h.memory
        .write_obj(0x300000u64, GuestAddress(h.rx.base + 16))
        .unwrap();
    let header = guest(REQUEST, 4321, 999);
    let bytes = header.encode();
    h.tx.submit(&h.memory, &bytes, false, bytes.len());
    h.device.on_event(DeviceEvent::QueueKick(1)).unwrap();
    let mut received = [0; HEADER_LEN];
    h.memory
        .read_slice(&mut received[..20], GuestAddress(h.rx.data))
        .unwrap();
    h.memory
        .read_slice(&mut received[20..], GuestAddress(h.rx.data + 0x11000))
        .unwrap();
    assert_eq!(received, header.reply(RST).header.encode());
    assert_eq!(
        h.device
            .active
            .as_ref()
            .unwrap()
            .ctx
            .queues
            .state(0)
            .unwrap()
            .next_used,
        1
    );
    let used_len: u32 = h.memory.read_obj(GuestAddress(h.rx.base + 0x2008)).unwrap();
    assert_eq!(u32::from_le(used_len), HEADER_LEN as u32);
}

#[test]
fn rx_intake_rejects_invalid_ranges_and_resubmitted_outstanding_heads() {
    let mut invalid = Harness::new(vec![]);
    invalid
        .memory
        .write_obj(0x300000u64, GuestAddress(invalid.rx.base))
        .unwrap();
    assert!(matches!(
        invalid.device.on_event(DeviceEvent::QueueKick(0)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert!(invalid.rx.take(&invalid.memory).is_empty());

    let mut duplicate = Harness::new(vec![]);
    duplicate.tick();
    duplicate
        .rx
        .submit(&duplicate.memory, &[], true, HEADER_LEN);
    assert!(matches!(
        duplicate.device.on_event(DeviceEvent::QueueKick(0)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert!(duplicate.rx.take(&duplicate.memory).is_empty());
}
