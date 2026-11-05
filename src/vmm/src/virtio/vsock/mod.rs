// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Stream-only virtio-vsock with explicit, nonblocking Unix socket mappings.

mod backend;
mod buffer;
mod connection;
mod packet;
mod source;

use super::queue::Completion;
use crate::virtio::{
    ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
    VirtioDevice,
};
use backend::{Backend, Mappings};
use buffer::Buffer;
use packet::{HEADER_LEN, Packet};
use std::{
    collections::{HashSet, VecDeque},
    io,
    os::unix::net::UnixListener,
    path::PathBuf,
    sync::Arc,
};
use virtio_queue::Reader;

const SPEC: DeviceSpec = DeviceSpec {
    device_id: 19,
    name: "vsock",
    features: 0,
    config_len: 8,
    queue_max: &[256, 256, 256],
    snapshot: SnapshotSupport::Unsupported,
};

/// Path ownership stays with the caller. The guest can reach only these mappings.
pub(crate) enum PortMapping {
    /// Host clients connect directly; accepted bytes become guest stream data.
    Listen { port: u32, listener: UnixListener },
    /// Guest connections to host `port` connect to the supplied Unix path.
    Connect { port: u32, path: PathBuf },
}

pub(crate) struct Vsock {
    cid: u64,
    mappings: Arc<Mappings>,
    features_set: bool,
    active: Option<Active>,
}

struct Active {
    backend: Backend,
    ctx: ActivationContext,
    // Intake captures packets/descriptor metadata before any completion lets
    // the driver reuse a head. Each deque is bounded by its queue maximum.
    tx: VecDeque<(u16, Packet)>,
    rx: VecDeque<Buffer>,
}

impl Vsock {
    pub(crate) fn new(cid: u64, ports: Vec<PortMapping>) -> io::Result<Self> {
        if !(3..u32::MAX as u64).contains(&cid) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "vsock guest CID must be in 3..0xffffffff",
            ));
        }
        let mut seen = HashSet::new();
        let mut mappings = Mappings::default();
        for mapping in ports {
            let port = match &mapping {
                PortMapping::Listen { port, .. } | PortMapping::Connect { port, .. } => *port,
            };
            if port == u32::MAX || !seen.insert(port) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "reserved or duplicate vsock port mapping",
                ));
            }
            match mapping {
                PortMapping::Listen { port, listener } => {
                    listener.set_nonblocking(true)?;
                    mappings.listeners.push((port, listener));
                }
                PortMapping::Connect { port, path } => {
                    // Validate pathname encoding/length before a guest can request a connect.
                    std::os::unix::net::SocketAddr::from_pathname(&path)?;
                    if path.as_os_str().is_empty() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "empty vsock Unix path",
                        ));
                    }
                    mappings.connects.insert(port, path);
                }
            }
        }
        Ok(Self {
            cid,
            mappings: Arc::new(mappings),
            features_set: false,
            active: None,
        })
    }
}

impl VirtioDevice for Vsock {
    fn spec(&self) -> &DeviceSpec {
        &SPEC
    }

    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        let unsupported = negotiated;
        if unsupported != 0 {
            return Err(FeatureError { unsupported });
        }
        self.features_set = true;
        Ok(())
    }

    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        let bytes = self.cid.to_le_bytes();
        data.fill(0);
        for (index, byte) in data.iter_mut().enumerate() {
            *byte = offset
                .checked_add(index as u64)
                .and_then(|n| usize::try_from(n).ok())
                .and_then(|n| bytes.get(n))
                .copied()
                .unwrap_or(0);
        }
        Ok(())
    }

    fn write_config(&mut self, _offset: u64, _data: &[u8]) -> Result<(), DeviceError> {
        Ok(())
    }

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        if self.active.is_some()
            || !self.features_set
            || ctx.queues.len() != 3
            || (0..3)
                .any(|index| !ctx.queues.is_ready(index) || ctx.queues.max_size(index) != Some(256))
        {
            return Err(DeviceError::NeedsReset("vsock activation"));
        }
        let backend = Backend::new(self.cid, self.mappings.clone(), ctx.events.clone())?;
        // Scan buffers published before DRIVER_OK even without a later kick.
        // The prepared generation keeps this request until the worker starts.
        (ctx.waker)();
        self.active = Some(Active {
            backend,
            ctx,
            tx: VecDeque::new(),
            rx: VecDeque::new(),
        });
        Ok(())
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.active = None;
        self.features_set = false;
        Ok(())
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        if matches!(event, DeviceEvent::QueueKick(index) if index > 2) {
            return Err(DeviceError::NeedsReset("vsock queue index"));
        }
        let Some(active) = &mut self.active else {
            return Ok(());
        };
        active.service()
    }
}

impl Active {
    fn service(&mut self) -> Result<(), DeviceError> {
        // No heads complete during intake, so a refilling guest cannot turn
        // this pass into an unbounded drain. Event buffers stay available:
        // this device does not support migration or transport-reset events.
        drain_buffers(&mut self.ctx, 0, &mut self.rx)?;
        let pending = &mut self.tx;
        let memory = &self.ctx.memory;
        let limit = self.ctx.queues.max_size(1).unwrap() as usize;
        self.ctx.queues.drain(1, |chain| {
            if pending.len() >= limit || chain.clone().any(|descriptor| descriptor.is_write_only())
            {
                return Err(bad_queue());
            }
            let head = chain.head_index();
            let mut reader = Reader::new(memory.as_ref(), chain).map_err(|_| bad_queue())?;
            let packet = Packet::read(&mut reader).map_err(|_| bad_queue())?;
            pending.push_back((head, packet));
            Ok(Completion::Deferred)
        })?;
        self.flush_rx()?;
        while self.backend.can_receive() {
            let Some((head, packet)) = self.tx.pop_front() else {
                break;
            };
            self.backend.receive(packet)?;
            self.complete(1, head, 0)?;
        }
        let mut again = self.backend.drive()?;
        // Backend I/O may have been skipped while outgoing was full. Recheck
        // once after RX frees capacity, even when no TX requests remain.
        again |= self.flush_rx()?;
        if again {
            (self.ctx.waker)();
        }
        Ok(())
    }

    fn complete(&mut self, index: usize, head: u16, length: u32) -> Result<(), DeviceError> {
        if self.ctx.queues.complete(index, head, length)? {
            self.ctx.interrupt.raise();
        }
        Ok(())
    }

    fn flush_rx(&mut self) -> Result<bool, DeviceError> {
        let mut delivered = false;
        while !self.rx.is_empty() && !self.backend.outgoing.is_empty() {
            let buffer = self.rx.pop_front().unwrap();
            let packet = self.backend.outgoing.front_mut().unwrap();
            let length = buffer.write_packet(&self.ctx.memory, packet)?;
            if length == 0 {
                self.complete(0, buffer.head, 0)?;
                continue;
            }
            let mut header = packet.header.clone();
            header.len = (length - HEADER_LEN) as u32;
            if header.len as usize == packet.payload.len() {
                self.backend.outgoing.pop_front();
            } else {
                // Keep the tail ahead of subsequent data and shutdown packets.
                packet.payload.drain(..header.len as usize);
                packet.header.len = packet.payload.len() as u32;
            }
            self.backend.delivered(&header);
            self.complete(0, buffer.head, length as u32)?;
            delivered = true;
        }
        Ok(delivered)
    }
}

fn drain_buffers(
    ctx: &mut ActivationContext,
    index: usize,
    pending: &mut VecDeque<Buffer>,
) -> Result<(), DeviceError> {
    let limit = ctx.queues.max_size(index).unwrap() as usize;
    ctx.queues.drain(index, |chain| {
        if pending.len() >= limit {
            return Err(bad_queue());
        }
        pending.push_back(Buffer::new(chain)?);
        Ok(Completion::Deferred)
    })?;
    Ok(())
}

fn bad_queue() -> DeviceError {
    DeviceError::NeedsReset("vsock descriptor queue")
}

#[cfg(test)]
#[path = "../../../tests/vsock/layers.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../tests/vsock/mod.rs"]
mod device_tests;
