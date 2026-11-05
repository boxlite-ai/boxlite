// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::virtio::vsock::tests::{Registrar, header};
use std::{
    fs,
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
};
use std::{
    io::{Read, Write},
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "vsock-layer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn next(backend: &mut Backend, op: u16) -> Packet {
    for _ in 0..100 {
        backend.drive().unwrap();
        if let Some(index) = backend
            .outgoing
            .iter()
            .position(|packet| packet.header.op == op)
        {
            return backend.outgoing.remove(index).unwrap();
        }
    }
    panic!("no backend operation {op}");
}

#[test]
fn mapped_guest_stream_survives_unmapped_flow_and_accounts_delivery() {
    let temp = Temp::new();
    let path = temp.0.join("connect");
    let listener = UnixListener::bind(&path).unwrap();
    let registrar = Arc::new(Registrar::new());
    let mappings = Mappings {
        connects: HashMap::from([(2696, path)]),
        ..Mappings::default()
    };
    let mut backend = Backend::new(3, Arc::new(mappings), registrar.clone()).unwrap();
    backend
        .receive(Packet {
            header: header(REQUEST),
            payload: vec![],
        })
        .unwrap();
    assert_eq!(next(&mut backend, RESPONSE).header.dst_port, 7000);
    let (mut host, _) = listener.accept().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

    backend
        .receive(Packet {
            header: Header {
                op: RW,
                len: 4,
                ..header(RW)
            },
            payload: b"ping".to_vec(),
        })
        .unwrap();
    assert_eq!(next(&mut backend, CREDIT_UPDATE).header.fwd_cnt, 4);
    let mut received = [0; 4];
    host.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"ping");
    backend
        .receive(Packet {
            header: Header {
                dst_port: 9999,
                ..header(REQUEST)
            },
            payload: vec![],
        })
        .unwrap();
    assert_eq!(next(&mut backend, RST).header.src_port, 9999);
    host.write_all(b"pong").unwrap();
    let response = next(&mut backend, RW);
    assert_eq!(response.payload, b"pong");
    backend.delivered(&response.header);
    backend
        .receive(Packet {
            header: Header {
                fwd_cnt: 4,
                ..header(CREDIT_UPDATE)
            },
            payload: vec![],
        })
        .unwrap();
    backend
        .receive(Packet {
            header: Header {
                fwd_cnt: 4,
                ..header(RST)
            },
            payload: vec![],
        })
        .unwrap();
    assert!(registrar.sources.lock().unwrap().is_empty());

    for port in 0..MAX_PENDING {
        assert!(backend.can_receive());
        backend
            .receive(Packet {
                header: Header {
                    src_port: port as u32,
                    dst_port: 9999,
                    ..header(REQUEST)
                },
                payload: vec![],
            })
            .unwrap();
    }
    assert!(!backend.can_receive());
    assert_eq!(backend.outgoing.len(), MAX_PENDING);
    backend.outgoing.pop_front();
    assert!(backend.can_receive());
}

#[test]
fn host_accepts_get_distinct_ports_and_wait_for_guest_response() {
    let temp = Temp::new();
    let path = temp.0.join("listen");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mappings = Mappings {
        listeners: vec![(2695, listener)],
        ..Mappings::default()
    };
    let registrar = Arc::new(Registrar::new());
    let mut backend = Backend::new(3, Arc::new(mappings), registrar.clone()).unwrap();
    let mut first = UnixStream::connect(&path).unwrap();
    let _second = UnixStream::connect(&path).unwrap();
    let request = next(&mut backend, REQUEST);
    let other = next(&mut backend, REQUEST);
    assert_ne!(request.header.src_port, other.header.src_port);
    assert_eq!(request.header.dst_port, 2695);
    first.write_all(b"host").unwrap();
    backend.drive().unwrap();
    assert!(!backend.outgoing.iter().any(|packet| packet.header.op == RW));
    let mut response = request.header.reply(RESPONSE);
    response.header.buf_alloc = BUFFER_SIZE as u32;
    backend.receive(response).unwrap();
    assert_eq!(next(&mut backend, RW).payload, b"host");
    drop(backend);
    assert!(registrar.sources.lock().unwrap().is_empty());
}

fn guest_packet(op: u16, guest: u32, flags: u32, payload: &[u8]) -> Packet {
    Packet {
        header: Header {
            src_port: guest,
            flags,
            len: payload.len() as u32,
            ..header(op)
        },
        payload: payload.to_vec(),
    }
}

fn guest_backend() -> (Temp, UnixListener, Backend, Arc<Registrar>) {
    let temp = Temp::new();
    let path = temp.0.join("guest");
    let listener = UnixListener::bind(&path).unwrap();
    let mappings = Arc::new(Mappings {
        connects: HashMap::from([(2696, path)]),
        ..Mappings::default()
    });
    let registrar = Arc::new(Registrar::new());
    let backend = Backend::new(3, mappings, registrar.clone()).unwrap();
    (temp, listener, backend, registrar)
}

fn open_guest(backend: &mut Backend, listener: &UnixListener, port: u32) -> UnixStream {
    backend
        .receive(guest_packet(REQUEST, port, 0, b""))
        .unwrap();
    assert_eq!(next(backend, RESPONSE).header.dst_port, port);
    let (host, _) = listener.accept().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    host.set_write_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    host
}

#[test]
fn output_pressure_preserves_round_robin_after_removal_and_admission() {
    let (_temp, listener, mut backend, _) = guest_backend();
    let mut hosts: Vec<_> = (7000..7003)
        .map(|port| open_guest(&mut backend, &listener, port))
        .collect();
    for (index, host) in hosts.iter_mut().enumerate() {
        host.write_all(&[index as u8]).unwrap();
    }
    for port in 0..MAX_PENDING {
        let mut request = guest_packet(REQUEST, port as u32, 0, b"");
        request.header.dst_port = 9999;
        backend.receive(request).unwrap();
    }
    assert!(!backend.can_receive());
    assert!(!backend.drive().unwrap());
    assert_eq!(backend.outgoing.len(), MAX_PENDING);
    // Leave only two output slots. Remove a flow and admit another before resuming.
    backend.outgoing.pop_front();
    backend.outgoing.pop_front();
    backend.receive(guest_packet(RST, 7001, 0, b"")).unwrap();
    backend
        .receive(guest_packet(REQUEST, 7003, 0, b""))
        .unwrap();
    let (mut newcomer, _) = listener.accept().unwrap();
    newcomer.write_all(&[3]).unwrap();
    let mut served = Vec::new();
    for _ in 0..3 {
        backend.drive().unwrap();
        assert!(backend.outgoing.len() <= MAX_PENDING);
        for packet in backend.outgoing.split_off(MAX_PENDING - 2) {
            if packet.header.op == RW {
                assert_eq!(packet.payload, vec![(packet.header.dst_port - 7000) as u8]);
                served.push(packet.header.dst_port);
            } else {
                assert_eq!(packet.header.op, RESPONSE);
            }
        }
    }
    served.sort_unstable();
    assert_eq!(
        served,
        [7000, 7002, 7003],
        "every surviving ready flow gets one turn"
    );
}

#[test]
fn connection_limit_stalls_host_accepts_until_a_guest_flow_is_removed() {
    let temp = Temp::new();
    let guest_path = temp.0.join("guest");
    let host_path = temp.0.join("host");
    let guest_listener = UnixListener::bind(&guest_path).unwrap();
    let host_listener = UnixListener::bind(&host_path).unwrap();
    host_listener.set_nonblocking(true).unwrap();
    let mappings = Arc::new(Mappings {
        listeners: vec![(9000, host_listener)],
        connects: HashMap::from([(2696, guest_path)]),
    });
    let registrar = Arc::new(Registrar::new());
    let mut backend = Backend::new(3, mappings, registrar.clone()).unwrap();
    let _hosts: Vec<_> = (0..MAX_CONNECTIONS)
        .map(|port| open_guest(&mut backend, &guest_listener, port as u32))
        .collect();
    backend
        .receive(guest_packet(REQUEST, 7000, 0, b""))
        .unwrap();
    assert_eq!(next(&mut backend, RST).header.dst_port, 7000);
    guest_listener.set_nonblocking(true).unwrap();
    assert_eq!(
        guest_listener.accept().unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    let _waiting = UnixStream::connect(&host_path).unwrap();
    assert!(!backend.drive().unwrap());
    assert!(backend.outgoing.is_empty());
    backend.receive(guest_packet(RST, 0, 0, b"")).unwrap();
    let request = next(&mut backend, REQUEST);
    assert_eq!(request.header.dst_port, 9000);
    assert_eq!(registrar.sources.lock().unwrap().len(), MAX_CONNECTIONS + 1);
    drop(backend);
    assert!(registrar.sources.lock().unwrap().is_empty());
}

#[test]
fn host_ports_skip_mappings_and_exhaustion_closes_only_new_accepts() {
    let temp = Temp::new();
    let path = temp.0.join("host");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mappings = Arc::new(Mappings {
        listeners: vec![(9000, listener)],
        connects: HashMap::from([(FIRST_HOST_PORT, temp.0.join("reserved"))]),
    });
    let mut backend = Backend::new(3, mappings, Arc::new(Registrar::new())).unwrap();
    assert!(!backend.drive().unwrap());
    let _first = UnixStream::connect(&path).unwrap();
    let request = next(&mut backend, REQUEST);
    assert_eq!(request.header.src_port, FIRST_HOST_PORT + 1);
    backend.ports = u32::MAX - 1..u32::MAX;
    let mut last = UnixStream::connect(&path).unwrap();
    let request = next(&mut backend, REQUEST);
    assert_eq!(request.header.src_port, u32::MAX - 1);
    let mut rejected = UnixStream::connect(&path).unwrap();
    rejected
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    backend.drive().unwrap();
    assert_eq!(rejected.read(&mut [0]).unwrap(), 0);
    assert!(backend.outgoing.is_empty());
    let mut response = request.header.reply(RESPONSE);
    response.header.buf_alloc = 10;
    backend.receive(response).unwrap();
    last.write_all(b"live").unwrap();
    assert_eq!(next(&mut backend, RW).payload, b"live");
}

#[test]
fn shutdown_and_bad_credit_discard_only_the_affected_flows_output() {
    let (_temp, listener, mut backend, registrar) = guest_backend();
    let mut first = open_guest(&mut backend, &listener, 7000);
    let mut second = open_guest(&mut backend, &listener, 7001);
    first.write_all(b"first").unwrap();
    second.write_all(b"second").unwrap();
    backend.drive().unwrap();
    assert_eq!(
        backend
            .outgoing
            .iter()
            .filter(|p| p.header.op == RW)
            .count(),
        2
    );
    backend
        .receive(guest_packet(SHUTDOWN, 7000, RECEIVE, b""))
        .unwrap();
    assert_eq!(backend.outgoing.len(), 1);
    assert_eq!(backend.outgoing.front().unwrap().payload, b"second");
    let mut premature = guest_packet(CREDIT_UPDATE, 7001, 0, b"");
    premature.header.fwd_cnt = 1;
    backend.receive(premature).unwrap();
    assert_eq!(backend.outgoing.len(), 1);
    assert_eq!(backend.outgoing.front().unwrap().header.op, RST);
    assert_eq!(registrar.sources.lock().unwrap().len(), 1);
    // Wrong-CID resets cannot remove a live flow.
    let mut wrong_cid = guest_packet(RST, 7000, 0, b"");
    wrong_cid.header.src_cid = 44;
    backend.receive(wrong_cid).unwrap();
    backend.receive(guest_packet(RW, 7000, 0, b"ping")).unwrap();
    backend.drive().unwrap();
    let mut bytes = [0; 4];
    first.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"ping");
}

#[test]
fn failed_listener_registration_rolls_back_and_keeps_mapping_sockets_usable() {
    use crate::virtio::{EventError, EventSource, SourceId};
    struct RejectSecond(Registrar, AtomicU32);
    impl EventRegistrar for RejectSecond {
        fn register(&self, source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
            if self.1.fetch_add(1, Ordering::Relaxed) == 1 {
                return Err(EventError::Closed);
            }
            self.0.register(source)
        }
        fn deregister(&self, id: SourceId) {
            self.0.deregister(id);
        }
    }
    let temp = Temp::new();
    let mut mappings = Mappings::default();
    for port in 0..2 {
        let socket = UnixListener::bind(temp.0.join(port.to_string())).unwrap();
        socket.set_nonblocking(true).unwrap();
        mappings.listeners.push((port, socket));
    }
    let mappings = Arc::new(mappings);
    let registrar = Arc::new(RejectSecond(Registrar::new(), AtomicU32::new(0)));
    assert!(Backend::new(3, mappings.clone(), registrar.clone()).is_err());
    assert!(registrar.0.sources.lock().unwrap().is_empty());
    assert_eq!(Arc::strong_count(&mappings), 1);
    for (port, listener) in &mappings.listeners {
        let mut host = UnixStream::connect(temp.0.join(port.to_string())).unwrap();
        host.write_all(b"ok").unwrap();
        let (mut device, _) = listener.accept().unwrap();
        device
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut bytes = [0; 2];
        device.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ok");
    }
}
