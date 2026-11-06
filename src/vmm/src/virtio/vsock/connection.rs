// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! One stream flow; the caller preserves outgoing order and confirms delivered payload.

use super::{packet::*, source::Registration};
use crate::virtio::{DeviceError, EventRegistrar};
use mio::Interest;
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    sync::Arc,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Key {
    pub guest: u32,
    pub host: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum State {
    Connecting,
    AwaitResponse,
    Established,
}

pub(super) struct Connection {
    // Fields drop in declaration order: release the polling copy before the I/O socket.
    registration: Registration,
    socket: UnixStream,
    state: State,
    key: Key,
    cid: u64,
    pending: VecDeque<u8>,
    peer_alloc: u32,
    peer_fwd: u32,
    tx_count: u32,
    delivered: u32,
    fwd_count: u32,
    guest_shutdown: u32,
    write_shutdown: bool,
    host_eof: bool,
    credit_requested: bool,
    lookahead: Option<u8>,
}

impl Connection {
    /// Takes a nonblocking socket; AwaitResponse callers send `packet(REQUEST, 0, [])`.
    pub fn new(
        socket: UnixStream,
        registrar: Arc<dyn EventRegistrar>,
        state: State,
        key: Key,
        cid: u64,
    ) -> Result<Self, DeviceError> {
        Ok(Self {
            registration: Registration::stream(
                &socket,
                registrar,
                Interest::READABLE | Interest::WRITABLE,
            )?,
            socket,
            state,
            key,
            cid,
            pending: VecDeque::new(),
            peer_alloc: 0,
            peer_fwd: 0,
            tx_count: 0,
            delivered: 0,
            fwd_count: 0,
            guest_shutdown: 0,
            write_shutdown: false,
            host_eof: false,
            credit_requested: false,
            lookahead: None,
        })
    }

    pub fn packet(&self, op: u16, flags: u32, payload: Vec<u8>) -> Packet {
        Packet {
            header: Header {
                src_cid: HOST_CID,
                dst_cid: self.cid,
                src_port: self.key.host,
                dst_port: self.key.guest,
                len: payload.len() as u32,
                socket_type: STREAM,
                op,
                flags,
                buf_alloc: BUFFER_SIZE as u32,
                fwd_cnt: self.fwd_count,
            },
            payload,
        }
    }

    /// Confirm only payload actually copied to the guest, never headers or retained tails.
    pub fn delivered(&mut self, count: u32) {
        self.delivered = self.delivered.wrapping_add(count);
    }

    pub fn receive(&mut self, packet: Packet) -> io::Result<Option<Packet>> {
        let h = &packet.header;
        let advanced = h.fwd_cnt.wrapping_sub(self.peer_fwd);
        if advanced > self.delivered.wrapping_sub(self.peer_fwd) {
            return Err(invalid("peer acknowledged unsent vsock bytes"));
        }
        self.peer_alloc = h.buf_alloc;
        self.peer_fwd = h.fwd_cnt;
        if self
            .peer_alloc
            .saturating_sub(self.tx_count.wrapping_sub(self.peer_fwd))
            > 0
        {
            self.credit_requested = false;
        }
        if (h.op != SHUTDOWN && h.flags != 0) || (h.op != RW && h.len != 0) {
            return Err(invalid("invalid vsock control fields"));
        }
        match (self.state, h.op) {
            (State::Connecting, REQUEST) => {}
            (State::AwaitResponse, RESPONSE) => self.state = State::Established,
            (State::Established, RW) if self.guest_shutdown & SEND == 0 => {
                if packet.payload.len() > BUFFER_SIZE - self.pending.len() {
                    return Err(invalid("guest exceeded vsock receive credit"));
                }
                self.pending.extend(packet.payload);
            }
            (State::Established, SHUTDOWN) if h.flags != 0 && h.flags & !(RECEIVE | SEND) == 0 => {
                self.guest_shutdown |= h.flags;
            }
            (State::Established, CREDIT_REQUEST) => {
                return Ok(Some(self.packet(CREDIT_UPDATE, 0, vec![])));
            }
            (State::Established, CREDIT_UPDATE) => {}
            _ => return Err(invalid("unexpected vsock operation")),
        }
        Ok(None)
    }

    /// One write/read per turn; successful reads or remaining write tails request another.
    /// Returns whether this flow is closed and whether runnable work may remain.
    pub fn drive(&mut self, outgoing: &mut VecDeque<Packet>) -> io::Result<(bool, bool)> {
        if self.state == State::AwaitResponse && self.registration.is_closed() {
            return Ok((true, false));
        }
        if self.state == State::Connecting {
            if let Some(error) = self.socket.take_error()? {
                return Err(error);
            }
            match self.socket.peer_addr() {
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotConnected | io::ErrorKind::WouldBlock
                    ) =>
                {
                    return Ok((false, false));
                }
                Err(error) => return Err(error),
            }
            self.state = State::Established;
            outgoing.push_back(self.packet(RESPONSE, 0, vec![]));
        }
        if self.state != State::Established {
            return Ok((false, false));
        }
        let mut again = false;
        if !self.pending.is_empty() {
            match self.socket.write(self.pending.as_slices().0) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => {
                    self.pending.drain(..count);
                    self.fwd_count = self.fwd_count.wrapping_add(count as u32);
                    outgoing.push_back(self.packet(CREDIT_UPDATE, 0, vec![]));
                    again = !self.pending.is_empty();
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => again = true,
                Err(error) => return Err(error),
            }
        }
        if self.guest_shutdown & SEND != 0 && self.pending.is_empty() && !self.write_shutdown {
            self.socket.shutdown(Shutdown::Write)?;
            self.write_shutdown = true;
        }
        if self.guest_shutdown == (RECEIVE | SEND) && self.pending.is_empty() {
            outgoing.push_back(self.packet(RST, 0, vec![]));
            return Ok((true, false));
        }
        if self.host_eof || self.guest_shutdown & RECEIVE != 0 {
            return Ok((false, again));
        }
        let credit =
            self.peer_alloc
                .saturating_sub(self.tx_count.wrapping_sub(self.peer_fwd)) as usize;
        if credit > 0
            && let Some(byte) = self.lookahead.take()
        {
            self.tx_count = self.tx_count.wrapping_add(1);
            outgoing.push_back(self.packet(RW, 0, vec![byte]));
            return Ok((false, true));
        }
        // At zero credit probe one byte; never read past retained data or send it uncredited.
        if self.lookahead.is_none() {
            let mut data = vec![0; credit.clamp(1, 4096)];
            match self.socket.read(&mut data) {
                Ok(0) => {
                    self.host_eof = true;
                    outgoing.push_back(self.packet(SHUTDOWN, SEND, vec![]));
                }
                Ok(_) if credit == 0 => self.lookahead = Some(data[0]),
                Ok(count) => {
                    data.truncate(count);
                    self.tx_count = self.tx_count.wrapping_add(count as u32);
                    outgoing.push_back(self.packet(RW, 0, data));
                    again = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => again = true,
                Err(error) => return Err(error),
            }
        }
        if credit == 0 && !self.host_eof && !self.credit_requested {
            outgoing.push_back(self.packet(CREDIT_REQUEST, 0, vec![]));
            self.credit_requested = true;
        }
        Ok((false, again))
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
#[path = "../../../tests/vsock/layers/connections.rs"]
mod tests;
