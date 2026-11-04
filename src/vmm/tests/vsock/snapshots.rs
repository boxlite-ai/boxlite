// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn resources(h: &Harness) -> RestoreContext {
    let ctx = h.context();
    RestoreContext {
        memory: ctx.memory,
        interrupt: ctx.interrupt,
        events: ctx.events,
        waker: ctx.waker,
        sender: ctx.sender,
    }
}

fn inactive_snapshot(negotiated: bool) -> DeviceSnapshot {
    let mut device = Vsock::new(3, vec![]).unwrap();
    if negotiated {
        device.set_features(0).unwrap();
    }
    device.quiesce().unwrap();
    device.save_state().unwrap()
}

// The facade cannot save yet. Capture real, prepared queue states at its
// boundary to test the device codec and restore-error path independently.
fn active_snapshot(h: &Harness) -> DeviceSnapshot {
    snapshot::State {
        cid: h.device.cid,
        features_set: h.device.features_set,
        queues: Some(
            (0..3)
                .map(|i| {
                    h.device
                        .active
                        .as_ref()
                        .unwrap()
                        .ctx
                        .queues
                        .state(i)
                        .unwrap()
                })
                .collect(),
        ),
    }
    .encode()
}

#[test]
fn inactive_roundtrip_preserves_negotiation_and_can_activate() {
    let h = Harness::new(vec![]);
    for negotiated in [false, true] {
        let saved = inactive_snapshot(negotiated);
        let mut target = Vsock::new(3, vec![]).unwrap();
        target.restore_state(saved.clone(), resources(&h)).unwrap();
        assert!(target.paused);
        assert_eq!(target.save_state().unwrap(), saved);
        assert_eq!(target.features_set, negotiated);
        if !negotiated {
            assert_eq!(
                target.activate(h.context()),
                Err(DeviceError::NeedsReset("vsock activation"))
            );
            target.set_features(0).unwrap();
        }
        target.activate(h.context()).unwrap();
        target.resume().unwrap();
        assert!(!target.paused);
        target.reset().unwrap();
        assert!(!target.features_set);
        assert!(!target.paused);
        assert!(target.active.is_none());
    }
}

#[test]
fn active_codec_preserves_queue_cursors_and_restore_propagates_stub_error() {
    let mut h = Harness::new(vec![]);
    h.send(Packet {
        header: guest(REQUEST, 7000, 9999),
        payload: vec![],
    });
    let saved = active_snapshot(&h);
    let decoded = snapshot::State::decode(saved.clone(), 3).unwrap();
    let queues = decoded.queues.unwrap();
    assert_eq!(queues[1].next_avail, 1);
    assert_eq!(queues[1].next_used, 1);
    for (i, queue) in queues.iter().enumerate() {
        assert_eq!(
            *queue,
            h.device
                .active
                .as_ref()
                .unwrap()
                .ctx
                .queues
                .state(i)
                .unwrap()
        );
    }
    let mut target = Vsock::new(3, vec![]).unwrap();
    let before = h.registrar.len();
    assert_eq!(
        target.restore_state(saved, resources(&h)),
        Err(DeviceError::Unsupported("virtqueue restore"))
    );
    assert!(!target.features_set);
    assert!(!target.paused);
    assert!(target.active.is_none());
    assert_eq!(h.registrar.len(), before);
}

#[test]
fn snapshot_rejects_wrong_identity_flags_lengths_and_active_target() {
    let mut h = Harness::new(vec![]);
    let inactive = inactive_snapshot(false);
    let active = active_snapshot(&h);
    let mut invalid = vec![];
    for original in [&inactive, &active] {
        for len in 0..original.payload.len() {
            let mut state = original.clone();
            state.payload.truncate(len);
            invalid.push(state);
        }
        let mut state = original.clone();
        state.payload.push(0);
        invalid.push(state);
    }
    let mut state = inactive.clone();
    state.format ^= 1;
    invalid.push(state);
    let mut state = inactive.clone();
    state.version += 1;
    invalid.push(state);
    for (index, value) in [(0, 4), (8, 2), (9, 2)] {
        let mut state = inactive.clone();
        state.payload[index] = value;
        invalid.push(state);
    }
    for (index, value) in [(8, 0), (10, 1), (18, 1), (19, 0), (53, 0), (87, 0)] {
        let mut state = active.clone();
        state.payload[index] = value;
        invalid.push(state);
    }
    let mut target = Vsock::new(3, vec![]).unwrap();
    target.set_features(0).unwrap();
    target.quiesce().unwrap();
    let before = target.save_state().unwrap();
    for state in invalid {
        assert_eq!(
            target.restore_state(state, resources(&h)),
            Err(DeviceError::NeedsReset("vsock snapshot"))
        );
        assert_eq!(target.save_state().unwrap(), before);
    }
    let ctx = resources(&h);
    assert_eq!(
        h.device.restore_state(inactive, ctx),
        Err(DeviceError::NeedsReset("vsock restore target is active"))
    );
    assert!(h.device.active.is_some());
}

#[test]
fn reset_event_waits_for_buffer_blocks_work_and_is_delivered_once() {
    let temp = Temp::new();
    let path = temp.path("agent");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Listen {
        port: 2695,
        listener,
    }]);
    // Exercise the post-restore boundary using prepared queues: queue restore
    // intentionally remains unsupported, so this is not a full round-trip.
    h.device.active.as_mut().unwrap().reset_pending = true;
    let _host = UnixStream::connect(&path).unwrap();
    h.send(Packet {
        header: guest(REQUEST, 7000, 9999),
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
            .state(1)
            .unwrap()
            .next_avail,
        0
    );
    assert_eq!(h.registrar.len(), 1);
    assert!(h.device.active.as_ref().unwrap().reset_pending);
    let mut events = Driver::new(2);
    events.submit(&h.memory, &[0xff; 4], true, 4);
    events.submit(&h.memory, &[0xff; 4], true, 4);
    h.device.quiesce().unwrap();
    h.tick();
    assert!(events.take(&h.memory).is_empty());
    h.device.resume().unwrap();
    h.tick();
    assert_eq!(events.take(&h.memory), vec![vec![0; 4]]);
    assert!(!h.device.active.as_ref().unwrap().reset_pending);
    assert_eq!(h.interrupt.interrupt_status() & 1, 1);
    assert_eq!(h.next(REQUEST).header.dst_port, 2695);
    assert_eq!(h.next(RST).header.dst_port, 7000);
    h.tick();
    assert!(events.take(&h.memory).is_empty());
    h.device.reset().unwrap();
    h.activate();
    assert!(!h.device.active.as_ref().unwrap().reset_pending);
}

#[test]
fn reset_event_rejects_short_or_readonly_buffers() {
    for (writable, len) in [(true, 3), (false, 4)] {
        let mut h = Harness::new(vec![]);
        h.device.active.as_mut().unwrap().reset_pending = true;
        let mut events = Driver::new(2);
        events.submit(&h.memory, &[0xff; 4], writable, len);
        assert_eq!(
            h.device.on_event(DeviceEvent::QueueKick(2)),
            Err(bad_queue())
        );
        assert!(h.device.active.as_ref().unwrap().reset_pending);
        assert!(events.take(&h.memory).is_empty());
    }
}
