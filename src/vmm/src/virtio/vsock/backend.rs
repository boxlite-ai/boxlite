// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::{
    connection::{Connection, Key, State},
    packet::*,
    source::Registered,
};
use crate::virtio::{DeviceError, EventRegistrar};
use mio::{
    Interest,
    net::{UnixListener, UnixStream},
};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    io,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub(super) const MAX_CONNECTIONS: usize = 128;
pub(super) const MAX_PENDING: usize = 256;
const FIRST_HOST_PORT: u32 = 1 << 30;

#[derive(Default)]
pub(super) struct Mappings {
    pub listeners: Vec<(u32, Arc<Mutex<UnixListener>>)>,
    pub connects: HashMap<u32, PathBuf>,
}

pub(super) struct Backend {
    cid: u64,
    registrar: Arc<dyn EventRegistrar>,
    listeners: Vec<(u32, Registered<UnixListener>)>,
    connects: HashMap<u32, PathBuf>,
    connections: BTreeMap<Key, Connection>,
    pub outgoing: VecDeque<Packet>,
    next_port: u32,
    cursor: Option<Key>,
}

impl Backend {
    pub fn new(
        cid: u64,
        mappings: &Mappings,
        registrar: Arc<dyn EventRegistrar>,
    ) -> Result<Self, DeviceError> {
        let mut listeners = Vec::new();
        for (port, listener) in &mappings.listeners {
            listeners.push((
                *port,
                Registered::new(listener.clone(), registrar.clone(), Interest::READABLE)?,
            ));
        }
        Ok(Self {
            cid,
            registrar,
            listeners,
            connects: mappings.connects.clone(),
            connections: BTreeMap::new(),
            outgoing: VecDeque::new(),
            next_port: FIRST_HOST_PORT,
            cursor: None,
        })
    }

    pub fn can_receive(&self) -> bool {
        self.outgoing.len() < MAX_PENDING
    }

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
        if h.socket_type != STREAM {
            let reset = h.reply(RST);
            self.remove(key);
            self.outgoing.push_back(reset);
            return Ok(());
        }
        if h.op == REQUEST && !self.connections.contains_key(&key) && h.len == 0 && h.flags == 0 {
            let socket = (self.connections.len() < MAX_CONNECTIONS)
                .then(|| self.connects.get(&key.host))
                .flatten()
                .and_then(|path| UnixStream::connect(path).ok());
            if let Some(socket) = socket {
                let socket = Registered::new(
                    Arc::new(Mutex::new(socket)),
                    self.registrar.clone(),
                    Interest::READABLE | Interest::WRITABLE,
                )?;
                let mut connection = Connection::new(socket, State::Connecting, key, self.cid);
                if connection.receive(packet).is_ok() {
                    self.connections.insert(key, connection);
                    return Ok(());
                }
                self.outgoing.push_back(connection.packet(RST, 0, vec![]));
            } else {
                self.outgoing.push_back(h.reply(RST));
            }
            return Ok(());
        }
        let reset = h.reply(RST);
        let stop_reading = h.op == SHUTDOWN && h.flags & RECEIVE != 0;
        match self
            .connections
            .get_mut(&key)
            .map(|connection| connection.receive(packet))
        {
            Some(Ok(response)) => {
                if stop_reading {
                    self.outgoing
                        .retain(|p| packet_key(p) != key || p.header.op != RW);
                }
                if let Some(response) = response {
                    self.outgoing.push_back(response);
                }
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
            && let Some(connection) = self.connections.get_mut(&Key {
                guest: header.dst_port,
                host: header.src_port,
            })
        {
            connection.delivered(header.len);
        }
    }

    /// Each listener accepts at most one connection; each flow gets one I/O turn.
    pub fn drive(&mut self) -> Result<bool, DeviceError> {
        let mut again = false;
        for index in 0..self.listeners.len() {
            if self.connections.len() >= MAX_CONNECTIONS || self.outgoing.len() >= MAX_PENDING {
                break;
            }
            let (guest_port, listener) = &self.listeners[index];
            let accepted = listener.io.lock().unwrap().accept();
            match accepted {
                Ok((socket, _)) => {
                    let guest_port = *guest_port;
                    let key = loop {
                        if self.next_port == u32::MAX {
                            break None;
                        }
                        let key = Key {
                            guest: guest_port,
                            host: self.next_port,
                        };
                        self.next_port += 1;
                        if !self.connects.contains_key(&key.host)
                            && !self.connections.contains_key(&key)
                        {
                            break Some(key);
                        }
                    };
                    let Some(key) = key else {
                        drop(socket);
                        continue;
                    };
                    let socket = Registered::new(
                        Arc::new(Mutex::new(socket)),
                        self.registrar.clone(),
                        Interest::READABLE | Interest::WRITABLE,
                    )?;
                    let connection = Connection::new(socket, State::AwaitResponse, key, self.cid);
                    self.outgoing
                        .push_back(connection.packet(REQUEST, 0, vec![]));
                    self.connections.insert(key, connection);
                    again = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => again = true,
                Err(_) => return Err(DeviceError::Fatal("vsock listener accept")),
            }
        }
        // Rotate the starting flow so RX starvation cannot privilege a low port.
        let mut keys: Vec<_> = self.connections.keys().copied().collect();
        if let Some(cursor) = self.cursor {
            let first = keys.partition_point(|key| *key <= cursor);
            let len = keys.len();
            if len != 0 {
                keys.rotate_left(first % len);
            }
        }
        for key in keys {
            // A connecting flow can emit RESPONSE, CREDIT_UPDATE and one read.
            if self.outgoing.len() + 3 > MAX_PENDING {
                break;
            }
            self.cursor = Some(key);
            let connection = self.connections.get_mut(&key).unwrap();
            match connection.drive(&mut self.outgoing) {
                Ok((closed, runnable)) => {
                    again |= runnable;
                    if closed {
                        self.connections.remove(&key);
                        self.outgoing
                            .retain(|p| packet_key(p) != key || p.header.op == RST);
                    }
                }
                Err(_) => {
                    let reset = connection.packet(RST, 0, vec![]);
                    self.remove(key);
                    self.outgoing.push_back(reset);
                }
            }
        }
        Ok(again)
    }

    fn remove(&mut self, key: Key) {
        self.connections.remove(&key);
        self.outgoing.retain(|packet| packet_key(packet) != key);
    }
}

fn packet_key(packet: &Packet) -> Key {
    Key {
        guest: packet.header.dst_port,
        host: packet.header.src_port,
    }
}
