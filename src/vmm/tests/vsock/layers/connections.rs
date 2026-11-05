// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::virtio::vsock::connection::{Connection, Key, State};
use std::{collections::VecDeque, net::Shutdown, os::unix::net::UnixStream};

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
fn both_handshakes_bridge_bytes_with_credit_and_independent_half_close() {
    for (state, handshake) in [
        (State::Connecting, REQUEST),
        (State::AwaitResponse, RESPONSE),
    ] {
        let registrar = Arc::new(Registrar::new());
        let (device, mut host) = UnixStream::pair().unwrap();
        device.set_nonblocking(true).unwrap();
        host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let socket = Registered::new(
            Arc::new(Mutex::new(mio::net::UnixStream::from_std(device))),
            registrar.clone(),
            Interest::READABLE | Interest::WRITABLE,
        )
        .unwrap();
        let mut connection = Connection::new(
            socket,
            state,
            Key {
                guest: 7000,
                host: 2696,
            },
            3,
        );
        let mut outgoing = VecDeque::new();
        if handshake == RESPONSE {
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
        assert_eq!(outgoing.pop_front().unwrap().payload, b"def");
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
