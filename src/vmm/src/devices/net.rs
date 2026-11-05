// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A modern virtio-net queue pair over gvproxy's QEMU Unix stream.

use crate::virtio::{
    ActivationContext, DeviceError, DeviceEvent, DeviceSpec, EventSource, FeatureError,
    SnapshotSupport, SourceId, VirtioDevice, queue::Completion,
};
use mio::{Interest, Registry, Token, event::Source};
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::PathBuf,
};
use virtio_queue::desc::split::Descriptor;
use vm_memory::{Bytes, GuestMemory, Permissions};

const RX: usize = 0;
const TX: usize = 1;
const FEATURES: u64 = 1 << 5; // MAC; VERSION_1 belongs to the transport.
const QUEUE_SIZE: u16 = 256;
const HEADER_LEN: usize = 12; // Modern virtio_net_hdr, including num_buffers.
const MAX_FRAME_LEN: usize = 65_549; // gvproxy's IPv4 ceiling plus Ethernet header.
const IO_BUDGET: usize = 256;
const SPEC: DeviceSpec = DeviceSpec {
    device_id: 1,
    name: "net",
    features: FEATURES,
    config_len: 6,
    queue_max: &[QUEUE_SIZE, QUEUE_SIZE],
    snapshot: SnapshotSupport::Unsupported,
};

pub(crate) struct Net {
    socket_path: PathBuf,
    mac: [u8; 6],
    active: Option<Active>,
    failed: bool,
}

impl Net {
    pub(crate) fn new(socket_path: PathBuf, mac: [u8; 6]) -> Self {
        Self {
            socket_path,
            mac,
            active: None,
            failed: false,
        }
    }
}

impl VirtioDevice for Net {
    fn spec(&self) -> &DeviceSpec {
        &SPEC
    }

    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        let unsupported = negotiated & !FEATURES;
        if unsupported != 0 {
            return Err(FeatureError { unsupported });
        }
        Ok(())
    }

    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        // The MMIO transport validates the whole configuration access.
        data.copy_from_slice(&self.mac[offset as usize..offset as usize + data.len()]);
        Ok(())
    }

    fn write_config(&mut self, _: u64, _: &[u8]) -> Result<(), DeviceError> {
        Ok(())
    }

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        if self.failed
            || self.active.is_some()
            || ctx.queues.len() != 2
            || (0..2).any(|i| !ctx.queues.is_ready(i) || ctx.queues.max_size(i) != Some(QUEUE_SIZE))
        {
            return Err(fault("activate", "invalid state or RX/TX queues"));
        }
        self.failed = true;
        let stream: UnixStream = mio::net::UnixStream::connect(&self.socket_path)
            .map_err(|e| fault("connect gvproxy", e))?
            .into();
        let connecting = stream.peer_addr().is_err();
        let source_id = register(&stream, &ctx)?;
        self.active = Some(Active {
            ctx,
            stream,
            source_id,
            connecting,
            pending: [VecDeque::new(), VecDeque::new()],
            tx: None,
            rx: Receive::default(),
        });
        self.failed = false;
        Ok(())
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.active = None;
        self.failed = false;
        Ok(())
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        if self.failed {
            return Err(DeviceError::NeedsReset("net"));
        }
        let Some(active) = self.active.as_mut() else {
            return Ok(());
        };
        if event != DeviceEvent::BackendReady(active.source_id)
            && !matches!(event, DeviceEvent::QueueKick(0 | 1))
        {
            return Ok(());
        }
        let result = active.process(event);
        if result.is_err() {
            self.failed = true;
            self.active = None;
        }
        result
    }
}

// Fixed read/write interests use Unix edge-triggered readiness for backpressure.
struct SocketSource(mio::net::UnixStream);
impl EventSource for SocketSource {
    fn as_source(&mut self) -> &mut dyn Source {
        self
    }
}

impl Source for SocketSource {
    fn register(&mut self, registry: &Registry, token: Token, _: Interest) -> io::Result<()> {
        self.0
            .register(registry, token, Interest::READABLE | Interest::WRITABLE)
    }

    fn reregister(&mut self, registry: &Registry, token: Token, _: Interest) -> io::Result<()> {
        self.0
            .reregister(registry, token, Interest::READABLE | Interest::WRITABLE)
    }

    fn deregister(&mut self, registry: &Registry) -> io::Result<()> {
        self.0.deregister(registry)
    }
}

struct Chain {
    head: u16,
    descriptors: Vec<Descriptor>,
}

struct Transmit {
    head: u16,
    bytes: Vec<u8>,
    written: usize,
}

struct Receive {
    bytes: Vec<u8>,
    read: usize,
}

impl Default for Receive {
    fn default() -> Self {
        Self {
            bytes: vec![0; 4],
            read: 0,
        }
    }
}

impl Receive {
    fn complete(&self) -> bool {
        self.bytes.len() > 4 && self.read == self.bytes.len()
    }
}

struct Active {
    ctx: ActivationContext,
    stream: UnixStream,
    source_id: SourceId,
    connecting: bool,
    pending: [VecDeque<Chain>; 2],
    tx: Option<Transmit>,
    rx: Receive,
}

impl Drop for Active {
    fn drop(&mut self) {
        self.ctx.events.deregister(self.source_id);
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

impl Active {
    fn process(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        if matches!(event, DeviceEvent::BackendReady(_)) {
            if let Some(error) = self
                .stream
                .take_error()
                .map_err(|e| fault("gvproxy status", e))?
            {
                return Err(fault("gvproxy readiness", error));
            }
            self.stream
                .peer_addr()
                .map_err(|e| fault("complete gvproxy connect", e))?;
            self.connecting = false;
        }
        if self.connecting {
            return Ok(());
        }
        // Backend readiness and either queue kick can unblock both directions.
        self.collect(TX)?;
        self.collect(RX)?;
        self.transmit()?;
        self.receive()
    }

    fn collect(&mut self, index: usize) -> Result<(), DeviceError> {
        let pending = &mut self.pending[index];
        let in_flight = usize::from(index == TX && self.tx.is_some());
        self.ctx.queues.drain(index, |chain| {
            if pending.len() + in_flight >= usize::from(QUEUE_SIZE) {
                return Err(fault("collect queue", "too many outstanding chains"));
            }
            let head = chain.head_index();
            let descriptors: Vec<_> = chain.clone().collect();
            let access = if index == RX {
                Permissions::Write
            } else {
                Permissions::Read
            };
            if descriptors.is_empty()
                || descriptors.iter().any(|d| {
                    d.flags() & !3 != 0
                        || d.is_write_only() != (index == RX)
                        || !chain
                            .memory()
                            .check_range(d.addr(), d.len() as usize, access)
                })
            {
                return Err(fault("validate chain", "invalid descriptor or guest range"));
            }
            pending.push_back(Chain { head, descriptors });
            Ok(Completion::Deferred)
        })?;
        Ok(())
    }

    fn transmit(&mut self) -> Result<(), DeviceError> {
        self.transmit_with(UnixStream::write)
    }

    fn transmit_with(
        &mut self,
        mut write: impl FnMut(&mut UnixStream, &[u8]) -> io::Result<usize>,
    ) -> Result<(), DeviceError> {
        for _ in 0..IO_BUDGET {
            if self.tx.is_none() {
                let Some(chain) = self.pending[TX].pop_front() else {
                    return Ok(());
                };
                let len: usize = chain.descriptors.iter().map(|d| d.len() as usize).sum();
                if !(HEADER_LEN + 14..=HEADER_LEN + MAX_FRAME_LEN).contains(&len) {
                    return Err(fault("TX packet", "invalid length"));
                }
                let mut bytes = vec![0; len];
                let mut offset = 0;
                for d in chain.descriptors {
                    let end = offset + d.len() as usize;
                    self.ctx
                        .memory
                        .read_slice(&mut bytes[offset..end], d.addr())
                        .map_err(|e| fault("read TX buffer", e))?;
                    offset = end;
                }
                // Ignore unknown flags and unused TX num_buffers, including Linux's nonzero values.
                if bytes[0] & 7 != 0 || bytes[1] != 0 {
                    return Err(fault("TX header", "unnegotiated offload"));
                }
                // Replace the header tail with QEMU length; skip the preceding eight bytes.
                bytes[HEADER_LEN - 4..HEADER_LEN]
                    .copy_from_slice(&((len - HEADER_LEN) as u32).to_be_bytes());
                self.tx = Some(Transmit {
                    head: chain.head,
                    bytes,
                    written: HEADER_LEN - 4,
                });
            }
            let tx = self.tx.as_mut().unwrap();
            if !advance(
                write(&mut self.stream, &tx.bytes[tx.written..]),
                &mut tx.written,
            )? {
                return Ok(());
            }
            if tx.written == tx.bytes.len() {
                if self.ctx.queues.complete(TX, tx.head, 0)? {
                    self.ctx.interrupt.raise();
                }
                self.tx = None;
            }
        }
        if self.tx.is_some() || !self.pending[TX].is_empty() {
            self.rearm()?;
        }
        Ok(())
    }

    fn receive(&mut self) -> Result<(), DeviceError> {
        for _ in 0..IO_BUDGET {
            if !self.rx.complete() {
                if !advance(
                    self.stream.read(&mut self.rx.bytes[self.rx.read..]),
                    &mut self.rx.read,
                )? {
                    return Ok(());
                }
                if self.rx.bytes.len() == 4 && self.rx.read == 4 {
                    let len = u32::from_be_bytes(self.rx.bytes[..].try_into().unwrap()) as usize;
                    if !(14..=MAX_FRAME_LEN).contains(&len) {
                        return Err(fault("RX prefix", "invalid frame length"));
                    }
                    self.rx.bytes.resize(HEADER_LEN + len, 0);
                    self.rx.bytes[..HEADER_LEN].fill(0);
                    self.rx.bytes[10] = 1; // num_buffers, little endian.
                    self.rx.read = HEADER_LEN;
                }
            }
            if self.rx.complete() {
                let Some(chain) = self.pending[RX].pop_front() else {
                    return Ok(());
                };
                let capacity: usize = chain.descriptors.iter().map(|d| d.len() as usize).sum();
                let mut written = 0;
                if capacity >= self.rx.bytes.len() {
                    for d in chain.descriptors {
                        let end = (written + d.len() as usize).min(self.rx.bytes.len());
                        if end > written {
                            self.ctx
                                .memory
                                .write_slice(&self.rx.bytes[written..end], d.addr())
                                .map_err(|e| fault("write RX buffer", e))?;
                        }
                        written = end;
                    }
                }
                if self.ctx.queues.complete(RX, chain.head, written as u32)? {
                    self.ctx.interrupt.raise();
                }
                self.rx = Receive::default();
            }
        }
        self.rearm()
    }

    // Re-register before dropping the old source to recheck socket readiness.
    // RX completes buffered packets before yielding; remaining work needs I/O.
    fn rearm(&mut self) -> Result<(), DeviceError> {
        let id = register(&self.stream, &self.ctx)?;
        self.ctx.events.deregister(self.source_id);
        self.source_id = id;
        Ok(())
    }
}

fn register(stream: &UnixStream, ctx: &ActivationContext) -> Result<SourceId, DeviceError> {
    let source = SocketSource(mio::net::UnixStream::from_std(
        stream.try_clone().map_err(|e| fault("clone gvproxy", e))?,
    ));
    ctx.events
        .register(Box::new(source))
        .map_err(|e| fault("register gvproxy", e))
}

fn advance(result: io::Result<usize>, offset: &mut usize) -> Result<bool, DeviceError> {
    match result {
        Ok(0) => Err(fault("gvproxy I/O", "EOF or zero-byte write")),
        Ok(n) => {
            *offset += n;
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(false),
        Err(e) if e.kind() == io::ErrorKind::Interrupted => Ok(true),
        Err(e) => Err(fault("gvproxy I/O", e)),
    }
}

fn fault(operation: &'static str, reason: impl std::fmt::Display) -> DeviceError {
    tracing::warn!(device = "net", operation, %reason, "virtio-net requires reset");
    DeviceError::NeedsReset(operation)
}

#[cfg(test)]
#[path = "../../tests/net/mod.rs"]
pub(crate) mod tests;
