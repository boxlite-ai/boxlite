// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::virtio::vsock::tests::{Registrar, header, poll};
use std::time::Duration;

fn packet(h: Header, payload: &[u8]) -> Packet {
    Packet {
        header: Header {
            len: payload.len() as u32,
            ..h
        },
        payload: payload.to_vec(),
    }
}

#[test]
fn pending_handshake_keeps_half_closed_hosts_until_both_directions_close() {
    for half in [Shutdown::Read, Shutdown::Write] {
        let registrar = Arc::new(Registrar::new());
        let (device, mut host) = UnixStream::pair().unwrap();
        device.set_nonblocking(true).unwrap();
        let mut connection = new_connection(device, registrar.clone(), State::AwaitResponse);
        let mut outgoing = VecDeque::new();
        host.write_all(b"buffered before handshake").unwrap();
        poll(&registrar);
        host.shutdown(half).unwrap();
        let events = poll(&registrar);
        if half == Shutdown::Write {
            assert!(events.iter().any(|event| event.is_read_closed()));
        }
        assert_eq!(
            connection.drive(&mut outgoing).unwrap(),
            (false, false),
            "a directional shutdown must not cancel the handshake"
        );
        assert!(outgoing.is_empty());

        // Full closure must be distinguishable from the earlier half-close.
        drop(host);
        assert!(!poll(&registrar).is_empty());
        assert_eq!(
            connection.drive(&mut outgoing).unwrap(),
            (true, false),
            "full closure must cancel the pending handshake despite buffered data"
        );
    }
}

#[test]
fn both_handshakes_bridge_bytes_with_credit_and_independent_half_close() {
    for (state, handshake) in [
        (State::Connecting, REQUEST),
        (State::AwaitResponse, RESPONSE),
    ] {
        let registrar = Arc::new(Registrar::new());
        let (device, mut host) = UnixStream::pair().unwrap();
        device.set_nonblocking(true).unwrap();
        host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut connection = new_connection(device, registrar.clone(), state);
        let mut outgoing = VecDeque::new();
        if handshake == RESPONSE {
            let request = connection.packet(REQUEST, 0, vec![]);
            assert_eq!(
                (request.header.src_cid, request.header.dst_cid),
                (HOST_CID, 3)
            );
            assert_eq!(
                (request.header.src_port, request.header.dst_port),
                (2696, 7000)
            );
            assert_eq!(connection.drive(&mut outgoing).unwrap(), (false, false));
            assert!(outgoing.is_empty());
        }
        connection.receive(packet(header(handshake), b"")).unwrap();
        connection.drive(&mut outgoing).unwrap();
        if handshake == REQUEST {
            assert_eq!(outgoing.pop_front().unwrap().header.op, RESPONSE);
        }
        assert!(outgoing.is_empty());

        connection.receive(packet(header(RW), b"request")).unwrap();
        connection.drive(&mut outgoing).unwrap();
        let mut request = [0; 7];
        host.read_exact(&mut request).unwrap();
        assert_eq!(&request, b"request");
        let update = outgoing.pop_front().unwrap();
        assert_eq!(
            (update.header.op, update.header.fwd_cnt),
            (CREDIT_UPDATE, 7)
        );

        let mut credit = Header {
            buf_alloc: 3,
            ..header(CREDIT_UPDATE)
        };
        connection.receive(packet(credit.clone(), b"")).unwrap();
        host.write_all(b"abcdef").unwrap();
        connection.drive(&mut outgoing).unwrap();
        assert_eq!(outgoing.pop_front().unwrap().payload, b"abc");
        connection.delivered(3);
        connection.drive(&mut outgoing).unwrap();
        assert_eq!(outgoing.pop_front().unwrap().header.op, CREDIT_REQUEST);
        assert!(outgoing.is_empty());
        credit.fwd_cnt = 3;
        connection.receive(packet(credit.clone(), b"")).unwrap();
        connection.drive(&mut outgoing).unwrap();
        let mut tail = outgoing.pop_front().unwrap().payload;
        if tail.len() < 3 {
            connection.drive(&mut outgoing).unwrap();
            tail.extend(outgoing.pop_front().unwrap().payload);
        }
        assert_eq!(tail, b"def");
        connection.delivered(3);
        credit.fwd_cnt = 7;
        assert!(connection.receive(packet(credit.clone(), b"")).is_err());
        credit.fwd_cnt = 6;
        connection.receive(packet(credit.clone(), b"")).unwrap();

        connection
            .receive(packet(
                Header {
                    op: SHUTDOWN,
                    flags: SEND,
                    ..credit.clone()
                },
                b"",
            ))
            .unwrap();
        connection.drive(&mut outgoing).unwrap();
        assert_eq!(host.read(&mut request).unwrap(), 0);
        host.shutdown(Shutdown::Write).unwrap();
        connection.drive(&mut outgoing).unwrap();
        let shutdown = outgoing.pop_front().unwrap();
        assert_eq!(
            (shutdown.header.op, shutdown.header.flags),
            (SHUTDOWN, SEND)
        );
        connection
            .receive(packet(
                Header {
                    op: SHUTDOWN,
                    flags: RECEIVE | SEND,
                    ..credit
                },
                b"",
            ))
            .unwrap();
        assert_eq!(connection.drive(&mut outgoing).unwrap(), (true, false));
        assert_eq!(outgoing.pop_front().unwrap().header.op, RST);
        drop(connection);
        assert!(registrar.sources.lock().unwrap().is_empty());
    }
}

fn new_connection(device: UnixStream, registrar: Arc<Registrar>, state: State) -> Connection {
    device.set_nonblocking(true).unwrap();
    Connection::new(
        device,
        registrar,
        state,
        Key {
            guest: 7000,
            host: 2696,
        },
        3,
    )
    .unwrap()
}

fn established(credit: u32) -> (Connection, UnixStream, Arc<Registrar>) {
    let registrar = Arc::new(Registrar::new());
    let (device, host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut connection = new_connection(device, registrar.clone(), State::AwaitResponse);
    connection
        .receive(packet(
            Header {
                buf_alloc: credit,
                ..header(RESPONSE)
            },
            b"",
        ))
        .unwrap();
    (connection, host, registrar)
}

#[test]
fn zero_credit_reports_empty_host_eof_once() {
    let (mut connection, host, _) = established(0);
    host.shutdown(Shutdown::Write).unwrap();
    let mut outgoing = VecDeque::new();
    for _ in 0..3 {
        assert_eq!(connection.drive(&mut outgoing).unwrap(), (false, false));
    }
    assert_eq!(outgoing.len(), 1);
    let shutdown = outgoing.pop_front().unwrap();
    assert_eq!(
        (shutdown.header.op, shutdown.header.flags),
        (SHUTDOWN, SEND)
    );
}

#[test]
fn zero_credit_reports_eof_after_last_reserved_bytes() {
    let (mut connection, mut host, _) = established(3);
    host.write_all(b"abc").unwrap();
    host.shutdown(Shutdown::Write).unwrap();
    let mut outgoing = VecDeque::new();
    connection.drive(&mut outgoing).unwrap();
    connection.drive(&mut outgoing).unwrap();
    let data = outgoing.pop_front().unwrap();
    assert_eq!(
        (data.header.op, data.payload.as_slice()),
        (RW, b"abc".as_slice())
    );
    let shutdown = outgoing.pop_front().unwrap();
    assert_eq!(
        (shutdown.header.op, shutdown.header.flags),
        (SHUTDOWN, SEND)
    );
    assert!(outgoing.is_empty());
}

#[test]
fn zero_credit_retains_data_before_eof_until_credit_returns() {
    for bytes in [b"a".as_slice(), b"abcdef"] {
        let (mut connection, mut host, _) = established(0);
        host.write_all(bytes).unwrap();
        host.shutdown(Shutdown::Write).unwrap();
        let mut outgoing = VecDeque::new();
        for _ in 0..3 {
            assert_eq!(connection.drive(&mut outgoing).unwrap(), (false, false));
        }
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing.pop_front().unwrap().header.op, CREDIT_REQUEST);
        let mut received = Vec::new();
        let mut shutdowns = 0;
        for _ in 0..bytes.len() + 3 {
            connection
                .receive(packet(
                    Header {
                        buf_alloc: 1,
                        fwd_cnt: received.len() as u32,
                        ..header(CREDIT_UPDATE)
                    },
                    b"",
                ))
                .unwrap();
            connection.drive(&mut outgoing).unwrap();
            while let Some(output) = outgoing.pop_front() {
                match output.header.op {
                    RW => {
                        assert_eq!(shutdowns, 0);
                        assert_eq!(output.payload.len(), 1);
                        connection.delivered(output.payload.len() as u32);
                        received.extend(output.payload);
                    }
                    SHUTDOWN => {
                        assert_eq!(received, bytes);
                        assert_eq!(output.header.flags, SEND);
                        shutdowns += 1;
                    }
                    other => panic!("unexpected operation {other}"),
                }
            }
        }
        assert_eq!(received, bytes);
        assert_eq!(shutdowns, 1);
    }
}

#[test]
fn reservations_only_accept_acknowledgments_for_delivered_fragments() {
    let (mut connection, mut host, _) = established(6);
    host.write_all(b"abcdef").unwrap();
    let mut outgoing = VecDeque::new();
    connection.drive(&mut outgoing).unwrap();
    assert_eq!(outgoing.pop_front().unwrap().payload, b"abcdef");
    let ack = |count| {
        packet(
            Header {
                fwd_cnt: count,
                buf_alloc: 6,
                ..header(CREDIT_UPDATE)
            },
            b"",
        )
    };
    assert_eq!(
        connection.receive(ack(1)).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    connection.delivered(2);
    connection.receive(ack(2)).unwrap();
    assert!(connection.receive(ack(3)).is_err());
    assert!(connection.receive(ack(1)).is_err());
    connection.delivered(4);
    connection.receive(ack(6)).unwrap();
    host.write_all(b"ghijkl").unwrap();
    connection.drive(&mut outgoing).unwrap();
    assert_eq!(outgoing.pop_front().unwrap().payload, b"ghijkl");
}

#[test]
fn counters_wrap_across_real_reads_delivery_and_writes() {
    let (mut connection, mut host, _) = established(3);
    // Seed a long-lived flow near wrap; bytes crossing the boundary still use real I/O.
    connection.tx_count = u32::MAX - 1;
    connection.delivered = u32::MAX - 1;
    connection.peer_fwd = u32::MAX - 1;
    connection.fwd_count = u32::MAX - 1;
    host.write_all(b"abc").unwrap();
    let mut outgoing = VecDeque::new();
    connection.drive(&mut outgoing).unwrap();
    assert_eq!(outgoing.pop_front().unwrap().payload, b"abc");
    let h = Header {
        fwd_cnt: 1,
        buf_alloc: 3,
        ..header(CREDIT_UPDATE)
    };
    assert!(connection.receive(packet(h.clone(), b"")).is_err());
    connection.delivered(3);
    connection.receive(packet(h.clone(), b"")).unwrap();
    connection
        .receive(packet(Header { op: RW, ..h }, b"xyz"))
        .unwrap();
    connection.drive(&mut outgoing).unwrap();
    let mut received = [0; 3];
    host.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"xyz");
    assert_eq!(outgoing.pop_front().unwrap().header.fwd_cnt, 1);
}

#[test]
fn pending_writes_are_bounded_and_partial_writes_drain_before_half_close() {
    let registrar = Arc::new(Registrar::new());
    let (mut device, mut host) = UnixStream::pair().unwrap();
    device.set_nonblocking(true).unwrap();
    host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    // Fill with small writes so draining two chunks frees less than a 64 KiB write.
    let mut filled = 0;
    for _ in 0..4096 {
        match device.write(&[0x55; 4096]) {
            Ok(count) => filled += count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            result => panic!("unexpected fill result: {result:?}"),
        }
    }
    assert!((8192..4096 * 4096).contains(&filled));
    let mut connection = new_connection(device, registrar, State::AwaitResponse);
    connection.receive(packet(header(RESPONSE), b"")).unwrap();
    let payload: Vec<u8> = (0..BUFFER_SIZE).map(|i| (i % 251) as u8).collect();
    connection.receive(packet(header(RW), &payload)).unwrap();
    let mut outgoing = VecDeque::new();
    assert_eq!(connection.drive(&mut outgoing).unwrap(), (false, false));
    assert!(outgoing.is_empty());
    assert_eq!(
        connection.packet(CREDIT_UPDATE, 0, vec![]).header.fwd_cnt,
        0
    );
    assert!(connection.receive(packet(header(RW), b"overflow")).is_err());
    connection
        .receive(packet(
            Header {
                flags: SEND,
                ..header(SHUTDOWN)
            },
            b"",
        ))
        .unwrap();
    host.read_exact(&mut [0; 8192]).unwrap();
    assert_eq!(connection.drive(&mut outgoing).unwrap(), (false, true));
    let partial = outgoing.pop_front().unwrap();
    assert_eq!(partial.header.op, CREDIT_UPDATE);
    assert!(partial.header.fwd_cnt > 0 && partial.header.fwd_cnt < BUFFER_SIZE as u32);
    host.set_nonblocking(true).unwrap();
    let mut received = Vec::new();
    let mut eof = false;
    for _ in 0..1024 {
        let mut buf = [0; 8192];
        match host.read(&mut buf) {
            Ok(0) => {
                eof = true;
                break;
            }
            Ok(count) => received.extend_from_slice(&buf[..count]),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            result => panic!("unexpected drain result: {result:?}"),
        }
        connection.drive(&mut outgoing).unwrap();
    }
    assert!(
        eof,
        "pending writes must drain and close the host write half"
    );
    assert_eq!(&received[..filled - 8192], vec![0x55; filled - 8192]);
    assert_eq!(&received[filled - 8192..], payload);
    assert_eq!(
        connection.packet(CREDIT_UPDATE, 0, vec![]).header.fwd_cnt,
        BUFFER_SIZE as u32
    );
    // The host can still reply after the guest's SEND shutdown.
    host.write_all(b"reply").unwrap();
    outgoing.clear();
    connection.drive(&mut outgoing).unwrap();
    assert_eq!(outgoing.pop_front().unwrap().payload, b"reply");
}

#[test]
fn receive_half_close_preserves_guest_writes_and_does_not_resume_reads() {
    let (mut connection, mut host, _) = established(0);
    host.write_all(b"buffered").unwrap();
    let mut outgoing = VecDeque::new();
    connection.drive(&mut outgoing).unwrap();
    outgoing.clear();
    connection
        .receive(packet(
            Header {
                flags: RECEIVE,
                ..header(SHUTDOWN)
            },
            b"",
        ))
        .unwrap();
    connection.receive(packet(header(RW), b"request")).unwrap();
    connection.drive(&mut outgoing).unwrap();
    let mut request = [0; 7];
    host.read_exact(&mut request).unwrap();
    assert_eq!(&request, b"request");
    assert_eq!(outgoing.pop_front().unwrap().header.op, CREDIT_UPDATE);
    connection
        .receive(packet(header(CREDIT_UPDATE), b""))
        .unwrap();
    assert_eq!(connection.drive(&mut outgoing).unwrap(), (false, false));
    assert!(outgoing.is_empty());
    connection
        .receive(packet(
            Header {
                flags: SEND,
                ..header(SHUTDOWN)
            },
            b"",
        ))
        .unwrap();
    assert_eq!(connection.drive(&mut outgoing).unwrap(), (true, false));
    assert_eq!(outgoing.pop_front().unwrap().header.op, RST);
}

#[test]
fn invalid_handshakes_and_operations_are_rejected() {
    for state in [State::Connecting, State::AwaitResponse] {
        for h in [
            header(RW),
            Header {
                flags: 1,
                ..header(RESPONSE)
            },
            header(CREDIT_UPDATE),
        ] {
            let (device, _host) = UnixStream::pair().unwrap();
            let mut connection = new_connection(device, Arc::new(Registrar::new()), state);
            assert_eq!(
                connection.receive(packet(h, b"")).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        }
    }
    for (op, flags, payload) in [
        (REQUEST, 0, b"".as_slice()),
        (RESPONSE, 0, b""),
        (SHUTDOWN, 0, b""),
        (SHUTDOWN, 4, b""),
        (SHUTDOWN, SEND, b"x"),
        (CREDIT_REQUEST, 0, b"x"),
        (CREDIT_UPDATE, 1, b""),
        (RW, 1, b"x"),
    ] {
        let (mut connection, _host, _) = established(10);
        assert!(
            connection
                .receive(packet(
                    Header {
                        flags,
                        ..header(op)
                    },
                    payload
                ))
                .is_err()
        );
    }
    let (mut connection, _host, _) = established(10);
    let reply = connection
        .receive(packet(header(CREDIT_REQUEST), b""))
        .unwrap()
        .unwrap();
    assert_eq!(reply.header.op, CREDIT_UPDATE);
    connection
        .receive(packet(
            Header {
                flags: SEND,
                ..header(SHUTDOWN)
            },
            b"",
        ))
        .unwrap();
    assert!(connection.receive(packet(header(RW), b"late")).is_err());
}

#[test]
fn drop_deregisters_before_closing_the_io_socket() {
    struct CheckingRegistrar {
        inner: Registrar,
        host: std::sync::Mutex<UnixStream>,
    }
    impl EventRegistrar for CheckingRegistrar {
        fn register(
            &self,
            source: Box<dyn crate::virtio::EventSource>,
        ) -> Result<crate::virtio::SourceId, crate::virtio::EventError> {
            self.inner.register(source)
        }
        fn deregister(&self, id: crate::virtio::SourceId) {
            self.inner.deregister(id);
            // The polling copy is gone, but the connection's I/O socket must still be open.
            assert_eq!(
                self.host.lock().unwrap().read(&mut [0]).unwrap_err().kind(),
                io::ErrorKind::WouldBlock
            );
        }
    }
    let (device, host) = UnixStream::pair().unwrap();
    device.set_nonblocking(true).unwrap();
    host.set_nonblocking(true).unwrap();
    let registrar = Arc::new(CheckingRegistrar {
        inner: Registrar::new(),
        host: std::sync::Mutex::new(host),
    });
    let connection = Connection::new(
        device,
        registrar.clone(),
        State::AwaitResponse,
        Key {
            guest: 7000,
            host: 2696,
        },
        3,
    )
    .unwrap();
    drop(connection);
    assert!(registrar.inner.sources.lock().unwrap().is_empty());
    assert_eq!(registrar.host.lock().unwrap().read(&mut [0]).unwrap(), 0);
}
