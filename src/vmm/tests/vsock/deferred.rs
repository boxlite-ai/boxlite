// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn stream_without_rx(path: PathBuf) -> (Harness, Header, UnixStream) {
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Connect { port: 2696, path }]);
    h.refill = false;
    // Only the handshake buffer is available, with room for its header alone.
    h.rx.avail = 1;
    h.memory
        .write_obj(1u16, GuestAddress(h.rx.base + 0x1002))
        .unwrap();
    h.memory
        .write_obj(HEADER_LEN as u32, GuestAddress(h.rx.base + 8))
        .unwrap();
    let header = h.guest_connect(2696);
    let (host, _) = listener.accept().unwrap();
    bounded(&host);
    (h, header, host)
}

#[test]
fn listener_readiness_during_output_pressure_rechecks_the_scanned_prefix() {
    let temp = Temp::new();
    let mappings = (0..257)
        .map(|port| PortMapping::Listen {
            port,
            listener: UnixListener::bind(temp.path(&port.to_string())).unwrap(),
        })
        .collect();
    let mut h = Harness::new(mappings);
    h.refill = false;
    h.rx.avail = 0;
    h.memory
        .write_obj(0u16, GuestAddress(h.rx.base + 0x1002))
        .unwrap();
    // The first budgeted round leaves the scan at listener 256.
    let ready = h.registrar.ready();
    assert_eq!(ready.len(), 1);
    h.device.on_event(ready[0]).unwrap();
    for port in 0..backend::MAX_PENDING {
        h.device
            .active
            .as_mut()
            .unwrap()
            .backend
            .receive(Packet {
                header: guest(REQUEST, port as u32, 9999),
                payload: vec![],
            })
            .unwrap();
    }
    // Consume the private continuation while output is full.
    let ready = h.registrar.ready();
    assert_eq!(ready.len(), 1);
    h.device.on_event(ready[0]).unwrap();
    let _host = UnixStream::connect(temp.path("0")).unwrap();
    let events = h.registrar.ready();
    assert!(
        !events.is_empty(),
        "the new connection must produce a readiness edge"
    );
    for event in events {
        h.device.on_event(event).unwrap();
    }
    assert!(
        h.registrar.ready().is_empty(),
        "output pressure must not spin"
    );

    h.rx.submit(&h.memory, &[], true, HEADER_LEN);
    h.device.on_event(DeviceEvent::QueueKick(0)).unwrap();
    for _ in 0..8 {
        let ready = h.registrar.ready();
        if ready.is_empty() {
            break;
        }
        for event in ready {
            h.device.on_event(event).unwrap();
        }
    }
    assert!(
        h.device
            .active
            .as_ref()
            .unwrap()
            .backend
            .outgoing
            .iter()
            .any(|p| { p.header.op == REQUEST && p.header.dst_port == 0 }),
        "resuming the tail lost readiness for the already-scanned listener"
    );
}

#[test]
fn rx_fragments_stream_to_chain_capacity_and_preserves_credit() {
    for (capacity, payload_len) in [(4096, 4096), (61, 256), (HEADER_LEN + 1, 17)] {
        let temp = Temp::new();
        let (mut h, mut header, mut host) = stream_without_rx(temp.path("fragment"));
        let payload: Vec<_> = (0..payload_len).map(|i| (i % 251) as u8).collect();
        host.write_all(&payload).unwrap();
        h.tick();
        assert!(h.packets.is_empty(), "data must wait for RX buffers");

        let mut received = Vec::new();
        while received.len() < payload.len() {
            let head = h.rx.avail % SIZE;
            h.rx.submit(&h.memory, &[], true, capacity);
            if capacity == 4096 {
                // Split the header across two contiguous writable descriptors.
                let descriptor = h.rx.base + u64::from(head) * 16;
                let next = (head + 1) % SIZE;
                h.memory
                    .write_obj(20u32, GuestAddress(descriptor + 8))
                    .unwrap();
                h.memory
                    .write_obj(3u16, GuestAddress(descriptor + 12))
                    .unwrap();
                h.memory
                    .write_obj(next, GuestAddress(descriptor + 14))
                    .unwrap();
                let mut tail = [0u8; 16];
                let address = h.rx.data + u64::from(head) * 0x11000 + 20;
                tail[..8].copy_from_slice(&address.to_le_bytes());
                tail[8..12].copy_from_slice(&((capacity - 20) as u32).to_le_bytes());
                tail[12..14].copy_from_slice(&2u16.to_le_bytes());
                h.memory
                    .write_slice(&tail, GuestAddress(h.rx.base + u64::from(next) * 16))
                    .unwrap();
            }
            h.tick();
            assert_eq!(h.packets.len(), 1, "one RX head must complete once");
            let packet = h.packets.pop_front().unwrap();
            assert_eq!(packet.header.op, RW);
            let count = (capacity - HEADER_LEN).min(payload.len() - received.len());
            assert_eq!(packet.payload.len(), count);
            assert_eq!(packet.header.len as usize, count);
            let entry = h.rx.base + 0x2004 + u64::from(h.rx.used.wrapping_sub(1) % SIZE) * 8;
            let used_len: u32 = h.memory.read_obj(GuestAddress(entry + 4)).unwrap();
            assert_eq!(u32::from_le(used_len) as usize, HEADER_LEN + count);
            received.extend(packet.payload);

            if received.len() == capacity - HEADER_LEN {
                // A header-only buffer cannot advance pending stream data.
                h.rx.submit(&h.memory, &[], true, HEADER_LEN);
                h.device.on_event(DeviceEvent::QueueKick(0)).unwrap();
                assert_eq!(h.rx.take(&h.memory), vec![Vec::<u8>::new()]);
            }
            header.op = CREDIT_UPDATE;
            header.fwd_cnt = received.len() as u32;
            h.send(Packet {
                header: header.clone(),
                payload: vec![],
            });
        }
        assert_eq!(received, payload);
        assert!(h.packets.is_empty());

        // Acknowledgments must leave the connection usable for further traffic.
        host.write_all(b"next").unwrap();
        host.shutdown(Shutdown::Write).unwrap();
        for expected in [b"ne", b"xt"] {
            h.rx.submit(&h.memory, &[], true, HEADER_LEN + 2);
            h.tick();
            assert_eq!(h.packets.len(), 1);
            let packet = h.packets.pop_front().unwrap();
            assert_eq!(
                packet.header.op, RW,
                "shutdown must follow all stream bytes"
            );
            assert_eq!(packet.payload, expected);
        }
        h.rx.submit(&h.memory, &[], true, HEADER_LEN);
        assert_eq!(h.next(SHUTDOWN).header.flags, SEND);

        // A chain that cannot hold even the header remains malformed.
        let bytes = guest(REQUEST, 9000, 9999).encode();
        h.tx.submit(&h.memory, &bytes, false, bytes.len());
        h.rx.submit(&h.memory, &[], true, HEADER_LEN - 1);
        assert!(matches!(
            h.device.on_event(DeviceEvent::QueueKick(0)),
            Err(DeviceError::NeedsReset(_))
        ));
        assert!(h.rx.take(&h.memory).is_empty());
    }
}

#[test]
fn rx_fragments_do_not_allow_acknowledging_the_undelivered_tail() {
    let temp = Temp::new();
    let (mut h, mut header, mut host) = stream_without_rx(temp.path("credit"));
    host.write_all(b"abcdef").unwrap();
    h.rx.submit(&h.memory, &[], true, HEADER_LEN + 3);
    assert_eq!(h.next(RW).payload, b"abc");
    header.op = CREDIT_UPDATE;
    header.fwd_cnt = 4;
    h.send(Packet {
        header,
        payload: vec![],
    });
    h.rx.submit(&h.memory, &[], true, HEADER_LEN);
    assert_eq!(h.next(RST).header.dst_port, 7000);
    assert!(!h.packets.iter().any(|packet| packet.header.op == RW));
}

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
    assert_tx_stalls_at_capacity_and_resumes_in_order(REQUEST);
}

#[test]
fn rst_tx_completes_at_capacity_without_reply() {
    assert_tx_stalls_at_capacity_and_resumes_in_order(RST);
}

#[test]
fn rst_tx_at_capacity_closes_only_its_flow_and_resumes_pending_tx() {
    let temp = Temp::new();
    let (mut h, mut header, mut host) = stream_without_rx(temp.path("reset"));
    host.write_all(b"discard on reset").unwrap();
    h.tick();
    let outgoing = &h.device.active.as_ref().unwrap().backend.outgoing;
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0].header.op, RW);
    assert_eq!(outgoing[0].payload, b"discard on reset");
    for port in 0..backend::MAX_PENDING as u32 - 1 {
        h.send(Packet {
            header: guest(REQUEST, port, 999),
            payload: vec![],
        });
    }
    let outgoing = &h.device.active.as_ref().unwrap().backend.outgoing;
    assert_eq!(outgoing.len(), backend::MAX_PENDING);
    let mut expected: Vec<_> = outgoing.iter().skip(1).map(|p| p.header.dst_port).collect();
    expected.push(9000);
    let registrations = h.registrar.len();
    let before = h.tx.avail;
    header.op = RST;
    for packet in [header, guest(REQUEST, 9000, 999)] {
        let bytes = packet.encode();
        h.tx.submit(&h.memory, &bytes, false, bytes.len());
    }
    h.device.on_event(DeviceEvent::QueueKick(1)).unwrap();
    assert_eq!(
        h.tx.take(&h.memory).len(),
        2,
        "RST must free output capacity for the following REQUEST without RX"
    );
    assert_eq!(h.registrar.len(), registrations - 1);
    assert_eq!(host.read(&mut [0u8; 1]).unwrap(), 0);
    let outgoing = &h.device.active.as_ref().unwrap().backend.outgoing;
    assert_eq!(outgoing.len(), backend::MAX_PENDING);
    assert_eq!(
        outgoing
            .iter()
            .map(|p| p.header.dst_port)
            .collect::<Vec<_>>(),
        expected,
        "reset must discard only its flow's output and produce no reply"
    );
    for offset in 0..2 {
        let head = (before + offset) % SIZE;
        let entry = h.tx.base + 0x2004 + u64::from(head) * 8;
        let id: u32 = h.memory.read_obj(GuestAddress(entry)).unwrap();
        assert_eq!(u32::from_le(id), u32::from(head));
    }
    h.tick();
    assert!(h.tx.take(&h.memory).is_empty(), "TX heads completed twice");
    assert!(h.packets.is_empty(), "no RX buffers were replenished");
}

#[test]
fn shutdown_tx_stalls_completion_at_capacity_and_resumes_in_order() {
    assert_tx_stalls_at_capacity_and_resumes_in_order(SHUTDOWN);
}

fn assert_tx_stalls_at_capacity_and_resumes_in_order(first_op: u16) {
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
        // Put the operation under test first so a stalled REQUEST cannot hide it.
        let op = if port == 0 {
            first_op
        } else if port == SIZE - 1 {
            // This RST must not overtake a preceding stalled packet.
            RST
        } else {
            REQUEST
        };
        let mut header = guest(op, 1000 + u32::from(port), 999);
        if op == SHUTDOWN {
            header.flags = SEND | RECEIVE;
        }
        let bytes = header.encode();
        h.tx.submit(&h.memory, &bytes, false, bytes.len());
    }
    assert!(h.registrar.ready().is_empty());
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
    let completed = u16::from(first_op == RST);
    assert_eq!(
        state.next_used,
        before + completed,
        "only a head RST may complete while output remains full"
    );
    assert_eq!(h.tx.take(&h.memory).len(), usize::from(completed));
    assert!(
        h.registrar.ready().is_empty(),
        "stalled capacity must not spin"
    );
    // Intake already copied TX bytes. Rewriting guest buffers must not change
    // the destination ports of requests that are waiting for output capacity.
    for head in 0..SIZE {
        h.memory
            .write_slice(
                &guest(REQUEST, 9999, 999).encode(),
                GuestAddress(h.tx.data + u64::from(head) * 0x11000),
            )
            .unwrap();
    }
    h.packets.clear();
    for _ in 0..backend::MAX_PENDING + SIZE as usize {
        h.rx.submit(&h.memory, &[], true, HEADER_LEN);
        h.tick();
    }
    let ports: Vec<_> = h.packets.iter().map(|p| p.header.dst_port).collect();
    let expected: Vec<_> = (SIZE as u32..SIZE as u32 + backend::MAX_PENDING as u32)
        // Unknown RSTs complete without replies; the other operations get RST.
        .chain((1000..1000 + SIZE as u32 - 1).filter(|port| first_op != RST || *port != 1000))
        .collect();
    assert_eq!(ports, expected);
    assert_eq!(h.tx.take(&h.memory).len(), usize::from(SIZE - completed));
    for head in 0..SIZE {
        let entry = h.tx.base + 0x2004 + u64::from((before + head) % SIZE) * 8;
        let id: u32 = h.memory.read_obj(GuestAddress(entry)).unwrap();
        assert_eq!(u32::from_le(id), u32::from((before + head) % SIZE));
    }
    h.tick();
    assert!(h.tx.take(&h.memory).is_empty(), "TX heads completed twice");
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
fn deferred_completion_notifies_once_per_used_head() {
    let mut h = Harness::new(vec![]);
    h.send(Packet {
        header: guest(REQUEST, 1234, 999),
        payload: vec![],
    });
    assert_eq!(h.next(RST).header.dst_port, 1234);
    assert_eq!(h.rx.used, 1);
    assert_eq!(h.tx.used, 1);
    assert_eq!(h.interrupt.interrupt_status(), 1);
    assert_eq!(h.interrupt.raises.load(Ordering::Relaxed), 2);
    h.tick();
    assert_eq!(h.interrupt.raises.load(Ordering::Relaxed), 2);
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
