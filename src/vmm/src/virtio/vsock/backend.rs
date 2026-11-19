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
    os::{
        fd::AsRawFd,
        unix::net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

/// Bounds sockets and per-flow buffers per backend.
pub(super) const MAX_CONNECTIONS: usize = 128;
/// Bounds queued output; callers reserve room before consuming non-RST guest TX.
pub(super) const MAX_PENDING: usize = 256;
/// Start host allocations above common service ports; explicit mappings are skipped too.
const FIRST_HOST_PORT: u32 = 1 << 30;
/// Undecided sockets do not consume guest flow slots and cannot persist indefinitely.
const MAX_SELECTIONS: usize = 32;
const SELECTION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(super) struct Mappings {
    pub listeners: Vec<(u32, UnixListener)>,
    pub connects: HashMap<u32, PathBuf>,
    pub control: Option<crate::VsockControl>,
}

struct Pending {
    // Deregister the polling duplicate before closing or transferring its stream.
    registration: Registration,
    socket: UnixStream,
    key: Key,
    deadline: Instant,
}

pub(super) struct Backend {
    // Deregister polling copies before releasing the last possible listener owner.
    _registrations: Vec<Registration>,
    mappings: Arc<Mappings>,
    registrar: Arc<dyn EventRegistrar>,
    cid: u64,
    connections: VecDeque<(Key, Connection)>,
    pending: VecDeque<Pending>,
    #[cfg(target_os = "linux")]
    selection_timer: Option<super::selection_timer::SelectionTimer>,
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
        #[cfg(target_os = "linux")]
        let selection_timer = mappings
            .control
            .as_ref()
            .map(|_| super::selection_timer::SelectionTimer::new(registrar.clone()))
            .transpose()?;
        Ok(Self {
            _registrations: registrations,
            mappings,
            registrar,
            cid,
            connections: VecDeque::new(),
            pending: VecDeque::new(),
            #[cfg(target_os = "linux")]
            selection_timer,
            ports: FIRST_HOST_PORT..u32::MAX,
            next_listener: 0,
            listener_retry: false,
            outgoing: VecDeque::new(),
        })
    }

    pub fn can_receive(&self) -> bool {
        self.outgoing.len() < MAX_PENDING
    }

    /// Non-RST packets require `can_receive`; RST only removes a flow and its output.
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
                    if self
                        .mappings
                        .control
                        .as_ref()
                        .is_some_and(|control| control.port == *guest)
                    {
                        // Evict the oldest undecided stream, preserving admission for clients
                        // that send a preface even when idle peers fill the selection budget.
                        if self.pending.len() == MAX_SELECTIONS {
                            self.pending.pop_front();
                        }
                        let registration = Registration::stream(
                            &socket,
                            self.registrar.clone(),
                            Interest::READABLE,
                        )?;
                        self.pending.push_back(Pending {
                            registration,
                            socket,
                            key,
                            deadline: Instant::now() + SELECTION_TIMEOUT,
                        });
                    } else {
                        self.accept_guest(socket, key)?;
                    }
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
        for _ in 0..self.pending.len() {
            let pending = self.pending.pop_front().unwrap();
            if Instant::now() >= pending.deadline {
                again = true;
                continue;
            }
            let mut prefix = 0u8;
            // Peek only. Full handshake and descriptor reception belong to the control
            // server; its client waits for the ACK before sending SCM_RIGHTS.
            // SAFETY: the stream is live and prefix is writable for one byte.
            let count = unsafe {
                libc::recv(
                    pending.socket.as_raw_fd(),
                    (&mut prefix as *mut u8).cast(),
                    1,
                    libc::MSG_PEEK | libc::MSG_DONTWAIT,
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    again |= error.kind() == io::ErrorKind::Interrupted;
                    self.pending.push_back(pending);
                    continue;
                }
            }
            let Pending {
                registration,
                socket,
                key,
                ..
            } = pending;
            drop(registration);
            if count == 1 {
                let control = self.mappings.control.as_ref().unwrap();
                if prefix == control.control_prefix {
                    // Queue saturation rejects only this connection and never stalls the worker.
                    let _ = control.connections.try_send(socket);
                } else if self.connections.len() < MAX_CONNECTIONS && self.can_receive() {
                    self.accept_guest(socket, key)?;
                }
            }
            again = true;
        }
        #[cfg(target_os = "linux")]
        if let Some(timer) = &mut self.selection_timer {
            timer.arm(self.pending.iter().map(|pending| pending.deadline).min())?;
        }
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
                    // An earlier listener scan may have stalled at the connection cap.
                    again = true;
                }
            }
        }
        Ok(again)
    }

    fn accept_guest(&mut self, socket: UnixStream, key: Key) -> Result<(), DeviceError> {
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
        Ok(())
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
