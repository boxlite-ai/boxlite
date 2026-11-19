// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::sync::mpsc::{Receiver, sync_channel};

const PORT: u32 = 2695;
const PREFACE: &[u8] = b"BOXLITE-MOUNT/1\n";

fn routed(capacity: usize) -> (Temp, Harness, Receiver<UnixStream>) {
    let dir = Temp::new();
    let (sender, receiver) = sync_channel(capacity);
    let device = Vsock::bind(
        &crate::VsockConfig {
            cid: 3,
            listen: vec![(PORT, dir.path("box.sock"))],
            connect: vec![],
        },
        Some(crate::VsockControl {
            port: PORT,
            control_prefix: b'B',
            connections: sender,
        }),
    )
    .unwrap();
    let mut h = Harness::new(vec![]);
    h.device.reset().unwrap();
    h.device = device;
    h.activate();
    (dir, h, receiver)
}

fn connect(dir: &Temp) -> UnixStream {
    let socket = UnixStream::connect(dir.path("box.sock")).unwrap();
    bounded(&socket);
    socket
}

fn assert_closed(socket: &mut UnixStream) {
    let mut byte = [0];
    match socket.read(&mut byte) {
        Ok(0) => {}
        Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
        result => panic!("expected closed connection: {result:?}"),
    }
}

#[test]
fn one_listener_preserves_guest_bytes_and_split_control_preface() {
    let (dir, mut h, receiver) = routed(32);
    let mut control = connect(&dir);
    control.write_all(&PREFACE[..1]).unwrap();
    h.tick();
    let mut received = receiver.try_recv().expect("first byte selects control");
    received.set_nonblocking(false).unwrap();
    bounded(&received);
    control.write_all(&PREFACE[1..]).unwrap();
    let mut preface = [0; PREFACE.len()];
    received.read_exact(&mut preface).unwrap();
    assert_eq!(&preface, PREFACE);
    assert!(
        h.packets.is_empty(),
        "control must not request a guest flow"
    );

    for bytes in [
        b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".as_slice(),
        b"CONNECT 2695\n",
    ] {
        let mut guest_stream = connect(&dir);
        guest_stream.write_all(bytes).unwrap();
        let request = h.next(REQUEST).header;
        assert_eq!(request.dst_port, PORT);
        h.send(Packet {
            header: guest(RESPONSE, request.dst_port, request.src_port),
            payload: vec![],
        });
        assert_eq!(h.next(RW).payload, bytes);
        h.send(Packet {
            header: guest(RST, request.dst_port, request.src_port),
            payload: vec![],
        });
    }
    assert!(receiver.try_recv().is_err());
}

#[test]
fn idle_selections_do_not_consume_guest_admission_and_oldest_is_evicted() {
    let (dir, mut h, receiver) = routed(32);
    let mut idle = Vec::new();
    for _ in 0..backend::MAX_CONNECTIONS {
        idle.push(connect(&dir));
        h.tick();
    }
    assert_closed(&mut idle[0]);
    let mut control = connect(&dir);
    control.write_all(b"B").unwrap();
    h.tick();
    assert!(receiver.try_recv().is_ok());
    let mut guest_stream = connect(&dir);
    guest_stream.write_all(b"P").unwrap();
    assert_eq!(h.next(REQUEST).header.dst_port, PORT);
}

#[test]
fn selection_deadline_wakes_without_new_guest_kicks_or_socket_bytes() {
    let (dir, mut h, _receiver) = routed(32);
    let mut idle = connect(&dir);
    idle.set_nonblocking(true).unwrap();
    h.tick();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "idle selection did not expire"
        );
        for event in h.registrar.ready() {
            h.device.on_event(event).unwrap();
        }
        match idle.read(&mut [0]) {
            Ok(0) => break,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            result => panic!("unexpected idle stream state: {result:?}"),
        }
    }
    assert!(h.packets.is_empty());
    // Retiring a socket schedules one continuation to resume listener admission.
    for event in h.registrar.ready() {
        h.device.on_event(event).unwrap();
    }
    assert!(
        h.registrar.ready().is_empty(),
        "expired timer must not remain ready"
    );
}

#[test]
fn reset_and_drop_close_pending_sockets_and_release_registrations() {
    let (dir, mut h, _receiver) = routed(32);
    let mut idle = connect(&dir);
    h.tick();
    h.device.reset().unwrap();
    assert_eq!(h.registrar.len(), 0);
    assert_closed(&mut idle);
    h.activate();
    let mut idle = connect(&dir);
    h.tick();
    let registrar = h.registrar.clone();
    drop(h);
    assert_eq!(registrar.len(), 0);
    assert_closed(&mut idle);
    assert!(!dir.path("box.sock").exists());
}

#[test]
fn full_and_disconnected_control_channels_reject_only_the_new_connection() {
    let (dir, mut h, receiver) = routed(1);
    let mut first = connect(&dir);
    first.write_all(b"B").unwrap();
    h.tick();
    let mut rejected = connect(&dir);
    rejected.write_all(b"B").unwrap();
    h.tick();
    assert_closed(&mut rejected);
    drop(receiver.try_recv().unwrap());
    drop(receiver);
    let mut rejected = connect(&dir);
    rejected.write_all(b"B").unwrap();
    h.tick();
    assert_closed(&mut rejected);
    let mut guest_stream = connect(&dir);
    guest_stream.write_all(b"P").unwrap();
    assert_eq!(h.next(REQUEST).header.dst_port, PORT);
}

#[test]
fn control_routing_leaves_other_listeners_raw() {
    let dir = Temp::new();
    let (sender, receiver) = sync_channel(32);
    let device = Vsock::bind(
        &crate::VsockConfig {
            cid: 3,
            listen: vec![
                (PORT, dir.path("box.sock")),
                (PORT + 1, dir.path("raw.sock")),
            ],
            connect: vec![],
        },
        Some(crate::VsockControl {
            port: PORT,
            control_prefix: b'B',
            connections: sender,
        }),
    )
    .unwrap();
    let mut h = Harness::new(vec![]);
    h.device.reset().unwrap();
    h.device = device;
    h.activate();
    let _idle_raw = UnixStream::connect(dir.path("raw.sock")).unwrap();
    assert_eq!(h.next(REQUEST).header.dst_port, PORT + 1);
    assert!(receiver.try_recv().is_err());
}

#[test]
fn control_requires_an_existing_listener() {
    let (sender, _receiver) = sync_channel(1);
    let error = Vsock::bind(
        &crate::VsockConfig {
            cid: 3,
            listen: vec![],
            connect: vec![],
        },
        Some(crate::VsockControl {
            port: PORT,
            control_prefix: b'B',
            connections: sender,
        }),
    )
    .err()
    .expect("a routing configuration must name a listener");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}
