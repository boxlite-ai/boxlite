// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::{
    IO_BUDGET,
    connection::{Connection, Key, State},
    packet::*,
    source::Registration,
};
use crate::virtio::{DeviceError, EventRegistrar};
use mio::Interest;
use std::{
    collections::{HashMap, VecDeque},
    io,
    ops::Range,
    os::unix::net::UnixListener,
    path::PathBuf,
    sync::Arc,
};

/// Bounds sockets and per-flow buffers per backend.
pub(super) const MAX_CONNECTIONS: usize = 128;
/// Bounds queued output; callers reserve room before consuming guest TX.
pub(super) const MAX_PENDING: usize = 256;
/// Start host allocations above common service ports; explicit mappings are skipped too.
const FIRST_HOST_PORT: u32 = 1 << 30;

#[derive(Default)]
pub(super) struct Mappings {
    pub listeners: Vec<(u32, UnixListener)>,
    pub connects: HashMap<u32, PathBuf>,
}

pub(super) struct Backend {
    // Deregister polling copies before releasing the last possible listener owner.
    _registrations: Vec<Registration>,
    mappings: Arc<Mappings>,
    registrar: Arc<dyn EventRegistrar>,
    cid: u64,
    connections: VecDeque<(Key, Connection)>,
    ports: Range<u32>,
    next_listener: usize,
    listener_retry: bool,
    pub outgoing: VecDeque<Packet>,
}

impl Backend {
    pub fn new(
        cid: u64,
        mappings: Arc<Mappings>,
        registrar: Arc<dyn EventRegistrar>,
    ) -> Result<Self, DeviceError> {
        let registrations = mappings
            .listeners
            .iter()
            .map(|(_, io)| Registration::listener(io, registrar.clone(), Interest::READABLE))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            _registrations: registrations,
            mappings,
            registrar,
            cid,
            connections: VecDeque::new(),
            ports: FIRST_HOST_PORT..u32::MAX,
            next_listener: 0,
            listener_retry: false,
            outgoing: VecDeque::new(),
        })
    }

    pub fn can_receive(&self) -> bool {
        self.outgoing.len() < MAX_PENDING
    }

    /// The caller must check `can_receive` before consuming a guest packet.
    pub fn receive(&mut self, packet: Packet) -> Result<(), DeviceError> {
        let h = &packet.header;
        if h.src_cid != self.cid || h.dst_cid != HOST_CID {
            return Ok(());
        }
        let key = Key {
            guest: h.src_port,
            host: h.dst_port,
        };
        if h.op == RST {
            self.remove(key);
            return Ok(());
        }
        if h.socket_type == STREAM
            && h.op == REQUEST
            && h.len == 0
            && h.flags == 0
            && self.connection(key).is_none()
            && self.connections.len() < MAX_CONNECTIONS
            && let Some(socket) = self
                .mappings
                .connects
                .get(&key.host)
                .and_then(|path| mio::net::UnixStream::connect(path).ok())
        {
            let connection = Connection::new(
                socket.into(),
                self.registrar.clone(),
                State::Connecting,
                key,
                self.cid,
            )?;
            self.connections.push_back((key, connection));
        }
        let reset = h.reply(RST);
        let stop_reading = h.op == SHUTDOWN && h.flags & RECEIVE != 0;
        let response = (h.socket_type == STREAM)
            .then(|| self.connection(key))
            .flatten()
            .map(|connection| connection.receive(packet));
        match response {
            Some(Ok(response)) => {
                if stop_reading {
                    self.outgoing
                        .retain(|p| reply_key(&p.header) != key || p.header.op != RW);
                }
                self.outgoing.extend(response);
            }
            _ => {
                self.remove(key);
                self.outgoing.push_back(reset);
            }
        }
        Ok(())
    }

    pub fn delivered(&mut self, header: &Header) {
        if header.op == RW
            && let Some(connection) = self.connection(reply_key(header))
        {
            connection.delivered(header.len);
        }
    }

    /// New readiness can belong to a listener already visited in this sweep.
    pub fn rescan(&mut self) {
        self.listener_retry |= self.next_listener != 0;
    }

    /// Bound listener scans; each of at most 128 flows gets one read/write turn.
    pub fn drive(&mut self) -> Result<bool, DeviceError> {
        for _ in 0..IO_BUDGET {
            let Some((guest, listener)) = self.mappings.listeners.get(self.next_listener) else {
                break;
            };
            if self.connections.len() >= MAX_CONNECTIONS || !self.can_receive() {
                break;
            }
            self.next_listener += 1;
            match listener.accept() {
                Ok((socket, _)) => {
                    self.listener_retry = true;
                    let Some(host) = self.ports.find(|p| !self.mappings.connects.contains_key(p))
                    else {
                        tracing::warn!("vsock host ports exhausted");
                        continue;
                    };
                    socket
                        .set_nonblocking(true)
                        .map_err(|_| DeviceError::Fatal("vsock nonblocking accept"))?;
                    let key = Key {
                        guest: *guest,
                        host,
                    };
                    let connection = Connection::new(
                        socket,
                        self.registrar.clone(),
                        State::AwaitResponse,
                        key,
                        self.cid,
                    )?;
                    self.outgoing
                        .push_back(connection.packet(REQUEST, 0, vec![]));
                    self.connections.push_back((key, connection));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                    self.listener_retry = true
                }
                Err(_) => return Err(DeviceError::Fatal("vsock listener accept")),
            }
        }
        let mut again = if self.next_listener == self.mappings.listeners.len() {
            self.next_listener = 0;
            // An early accept may need another try after a later chunk was empty.
            std::mem::take(&mut self.listener_retry)
        } else {
            self.connections.len() < MAX_CONNECTIONS && self.can_receive()
        };
        for _ in 0..self.connections.len() {
            // A connection emits at most one write update and one read/control packet.
            if self.outgoing.len() + 2 > MAX_PENDING {
                break;
            }
            let (key, mut connection) = self.connections.pop_front().unwrap();
            match connection.drive(&mut self.outgoing) {
                Ok((false, runnable)) => {
                    again |= runnable;
                    self.connections.push_back((key, connection));
                }
                _ => {
                    self.outgoing.retain(|p| reply_key(&p.header) != key);
                    self.outgoing.push_back(connection.packet(RST, 0, vec![]));
                }
            }
        }
        Ok(again)
    }

    fn connection(&mut self, key: Key) -> Option<&mut Connection> {
        self.connections
            .iter_mut()
            .find(|(k, _)| *k == key)
            .map(|(_, c)| c)
    }

    fn remove(&mut self, key: Key) {
        self.connections.retain(|(k, _)| *k != key);
        self.outgoing.retain(|p| reply_key(&p.header) != key);
    }
}

fn reply_key(header: &Header) -> Key {
    Key {
        guest: header.dst_port,
        host: header.src_port,
    }
}

#[cfg(test)]
#[path = "../../../tests/vsock/layers/backend.rs"]
mod tests;
