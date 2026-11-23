// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-mem device (VIRTIO 1.4 §5.15) over [`HotplugMemory`].
//!
//! The host sets a target with [`crate::VmControl::set_memory_target_mib`]; the device publishes
//! it as `requested_size` and raises a configuration interrupt. The guest
//! driver then plugs or unplugs blocks through the request queue. A plug above
//! the target gets NACK, never ERROR: Linux marks the device broken after an
//! ERROR. Shrinking is best effort; [`crate::VmControl::memory_status`] reports what the
//! guest actually holds.

use std::{io, sync::Arc};

use boxlite_hypervisor::Vm;
use virtio_queue::DescriptorChain;
use vm_memory::Bytes;

use crate::{
    control::{MemoryRequest, MemoryRequests},
    hotplug::{BLOCK_SIZE, BlockState, HotplugMemory, SLOT_SIZE},
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
        SourceId, VirtioDevice, queue::Completion,
    },
};

/// `VIRTIO_MEM_F_UNPLUGGED_INACCESSIBLE`: the driver never reads unplugged
/// memory, which the VMM leaves unmapped.
const UNPLUGGED_INACCESSIBLE: u64 = 1 << 1;
const SPEC: DeviceSpec = DeviceSpec {
    device_id: 24,
    name: "virtio-mem",
    features: UNPLUGGED_INACCESSIBLE,
    config_len: 56,
    queue_max: &[128],
    snapshot: SnapshotSupport::Unsupported,
};
const MIB: u64 = 1 << 20;

const PLUG: u16 = 0;
const UNPLUG: u16 = 1;
const UNPLUG_ALL: u16 = 2;
const STATE: u16 = 3;
const ACK: u16 = 0;
const NACK: u16 = 1;
const BUSY: u16 = 2;
const ERROR: u16 = 3;

/// What the guest holds, in MiB above the boot RAM.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemoryStatus {
    /// The configured hotplug capacity.
    pub capacity_mib: u32,
    /// The current host target.
    pub requested_mib: u32,
    /// Memory the guest has plugged.
    pub plugged_mib: u32,
    /// Host memory mapped for the guest; at least `plugged_mib`.
    pub mapped_mib: u32,
}

/// The virtio-mem device and the hotplug window it drives.
pub(crate) struct VirtioMem<H: Vm + ?Sized> {
    memory: HotplugMemory<H>,
    controls: MemoryRequests,
    requested: u64,
    features: u64,
    active: Option<Active>,
}

struct Active {
    context: ActivationContext,
    control: SourceId,
}

/// Adds the device on `slot` and registers its VM control endpoint.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn add<H: Vm + Send + Sync + 'static>(
    chipset: &mut crate::chipset::ChipsetBuilder,
    ctx: &mut crate::virtio::DeviceContext<'_>,
    slot: crate::virtio::mmio::Slot,
    memory: HotplugMemory<H>,
) -> crate::Result<()> {
    let controls = ctx
        .controls
        .register_memory()
        .map_err(crate::Error::RegisterMemoryControl)?;
    let device = Arc::new(std::sync::Mutex::new(VirtioMem::new(memory, controls)));
    crate::virtio::mmio::add_device(chipset, ctx, SPEC.name, slot, device)
}

impl<H: Vm + ?Sized> VirtioMem<H> {
    pub(crate) fn new(memory: HotplugMemory<H>, controls: MemoryRequests) -> Self {
        Self {
            memory,
            controls,
            requested: 0,
            features: 0,
            active: None,
        }
    }

    fn apply_controls(&mut self) {
        let count = match self.controls.batch_len() {
            Ok(count) => count,
            Err(error) => {
                tracing::warn!(%error, "virtio-mem control wakeup failed");
                return;
            }
        };
        for _ in 0..count {
            match self.controls.claim() {
                Some(MemoryRequest::SetTarget { added_mib, reply }) => {
                    let _ = reply.try_send(self.set_target(added_mib));
                }
                Some(MemoryRequest::Status(reply)) => {
                    let _ = reply.try_send(Ok(self.status()));
                }
                None => break,
            }
        }
    }

    fn set_target(&mut self, added_mib: u32) -> io::Result<()> {
        let bytes = u64::from(added_mib) * MIB;
        if !bytes.is_multiple_of(SLOT_SIZE) || bytes > self.memory.size() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid hotplug memory size: {added_mib} MiB"),
            ));
        }
        let active = self
            .active
            .as_ref()
            .expect("host controls run on the active device");
        self.requested = bytes;
        active.context.interrupt.raise_config();
        Ok(())
    }

    fn status(&self) -> MemoryStatus {
        let mib = |bytes: u64| (bytes / MIB) as u32;
        MemoryStatus {
            capacity_mib: mib(self.memory.size()),
            requested_mib: mib(self.requested),
            plugged_mib: mib(self.memory.plugged_bytes()),
            mapped_mib: mib(self.memory.mapped_bytes()),
        }
    }

    fn config(&self) -> [u8; 56] {
        let mut config = [0; 56];
        let fields = [
            (0, BLOCK_SIZE),
            (16, self.memory.base()),
            (24, self.memory.size()),
            (32, self.memory.size()),
            (40, self.memory.plugged_bytes()),
            (48, self.requested),
        ];
        for (offset, value) in fields {
            config[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        config
    }

    /// Handles one request and returns the response type and block state.
    fn handle(&mut self, kind: u16, addr: u64, count: u16) -> (u16, u16) {
        if kind == UNPLUG_ALL {
            if let Err(error) = self.memory.unplug_all() {
                tracing::warn!(%error, "virtio-mem unplug-all left a slot mapped");
            }
            return (ACK, 0);
        }
        let Some(blocks) = self.memory.blocks(addr, count) else {
            return (ERROR, 0);
        };
        let state = self.memory.state(blocks.clone());
        match (kind, state) {
            (STATE, state) => (ACK, state_code(state)),
            (PLUG, BlockState::Unplugged) => {
                let added = blocks.len() as u64 * BLOCK_SIZE;
                if self.memory.plugged_bytes() + added > self.requested {
                    (NACK, 0)
                } else if self.memory.plug(blocks).is_err() {
                    (BUSY, 0)
                } else {
                    (ACK, 0)
                }
            }
            (UNPLUG, BlockState::Plugged) => {
                if let Err(error) = self.memory.unplug(blocks.clone()) {
                    tracing::warn!(%error, "virtio-mem unplug left a slot mapped");
                }
                // The blocks are unplugged even when a slot stays mapped.
                match self.memory.state(blocks) {
                    BlockState::Unplugged => (ACK, 0),
                    _ => (BUSY, 0),
                }
            }
            _ => (ERROR, 0),
        }
    }

    fn request(
        &mut self,
        mut chain: DescriptorChain<&GuestMemoryMmap>,
    ) -> std::result::Result<Completion, DeviceError> {
        let invalid = || DeviceError::NeedsReset("virtio-mem request descriptors");
        let request = chain.next().ok_or_else(invalid)?;
        let response = chain.next().ok_or_else(invalid)?;
        let memory = chain.memory();
        if request.is_write_only()
            || request.len() < 24
            || !response.is_write_only()
            || response.len() < 10
            || response.has_next()
        {
            return Err(invalid());
        }
        let mut bytes = [0u8; 24];
        memory
            .read_slice(&mut bytes, request.addr())
            .map_err(|_| invalid())?;
        let field = |range: std::ops::Range<usize>| -> [u8; 8] {
            let mut out = [0; 8];
            out[..range.len()].copy_from_slice(&bytes[range]);
            out
        };
        let kind = u64::from_le_bytes(field(0..2)) as u16;
        let addr = u64::from_le_bytes(field(8..16));
        let count = u64::from_le_bytes(field(16..18)) as u16;
        let (kind, state) = self.handle(kind, addr, count);
        let mut reply = [0u8; 10];
        reply[0..2].copy_from_slice(&kind.to_le_bytes());
        reply[8..10].copy_from_slice(&state.to_le_bytes());
        memory
            .write_slice(&reply, response.addr())
            .map_err(|_| invalid())?;
        Ok(Completion::Used(reply.len() as u32))
    }
}

impl<H: Vm + Send + Sync + ?Sized> VirtioDevice for VirtioMem<H> {
    fn spec(&self) -> &DeviceSpec {
        &SPEC
    }

    fn set_features(&mut self, negotiated: u64) -> std::result::Result<(), FeatureError> {
        let unsupported = negotiated & !UNPLUGGED_INACCESSIBLE;
        if unsupported != 0 {
            return Err(FeatureError { unsupported });
        }
        self.features = negotiated;
        Ok(())
    }

    fn read_config(
        &mut self,
        offset: u64,
        data: &mut [u8],
    ) -> std::result::Result<(), DeviceError> {
        let config = self.config();
        for (index, byte) in data.iter_mut().enumerate() {
            *byte = offset
                .checked_add(index as u64)
                .and_then(|address| config.get(address as usize))
                .copied()
                .unwrap_or(0);
        }
        Ok(())
    }

    fn write_config(&mut self, _: u64, _: &[u8]) -> std::result::Result<(), DeviceError> {
        // Every field is read-only for the driver.
        Ok(())
    }

    fn activate(&mut self, ctx: ActivationContext) -> std::result::Result<(), DeviceError> {
        if self.active.is_some()
            || self.features & UNPLUGGED_INACCESSIBLE == 0
            || ctx.queues.len() != 1
            || !ctx.queues.is_ready(0)
        {
            return Err(DeviceError::NeedsReset("virtio-mem activation"));
        }
        let control = self
            .controls
            .prepare()
            .and_then(|source| ctx.events.register(source).map_err(io::Error::other))
            .map_err(|error| {
                tracing::warn!(%error, "virtio-mem control source was not registered");
                DeviceError::NeedsReset("virtio-mem control source")
            })?;
        self.active = Some(Active {
            context: ctx,
            control,
        });
        Ok(())
    }

    fn reset(&mut self) -> std::result::Result<(), DeviceError> {
        // Plugged blocks survive a reset: a reprobing driver unplugs them all.
        self.features = 0;
        if let Some(active) = self.active.take() {
            active.context.events.deregister(active.control);
        }
        Ok(())
    }

    fn on_event(&mut self, event: DeviceEvent) -> std::result::Result<(), DeviceError> {
        if let DeviceEvent::BackendReady(id) = event
            && self
                .active
                .as_ref()
                .is_some_and(|active| active.control == id)
        {
            self.apply_controls();
            return Ok(());
        }
        let DeviceEvent::QueueKick(0) = event else {
            return Err(DeviceError::Unsupported("virtio-mem event"));
        };
        let mut active = self
            .active
            .take()
            .ok_or(DeviceError::NeedsReset("inactive virtio-mem"))?;
        let result = active.context.queues.drain(0, |chain| self.request(chain));
        let interrupt = Arc::clone(&active.context.interrupt);
        self.active = Some(active);
        if result? {
            interrupt.raise();
        }
        Ok(())
    }
}

/// The VIRTIO STATE response code for `state`.
fn state_code(state: BlockState) -> u16 {
    match state {
        BlockState::Plugged => 0,
        BlockState::Unplugged => 1,
        BlockState::Mixed => 2,
    }
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../../tests/mem/mod.rs"]
mod tests;
