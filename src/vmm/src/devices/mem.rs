// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-mem device (VIRTIO 1.4 §5.15) over [`HotplugMemory`].
//!
//! The host sets a target with [`MemoryHandle::request`]; the device publishes
//! it as `requested_size` and raises a configuration interrupt. The guest
//! driver then plugs or unplugs blocks through the request queue. A plug above
//! the target gets NACK, never ERROR: Linux marks the device broken after an
//! ERROR. Shrinking is best effort; [`MemoryHandle::status`] reports what the
//! guest actually holds.

use std::sync::{Arc, Mutex, PoisonError};

use boxlite_hypervisor::Vm;
use virtio_queue::DescriptorChain;
use vm_memory::Bytes;

use crate::{
    error::{Error, Result},
    hotplug::{BLOCK_SIZE, BlockState, HotplugMemory, SLOT_SIZE},
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
        VirtioDevice, queue::Completion,
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

/// Sets the hotplug target of a running VM from any thread.
#[derive(Clone)]
pub struct MemoryHandle(Arc<dyn MemoryControl>);

impl std::fmt::Debug for MemoryHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // No status: formatting must not take the device lock.
        f.debug_struct("MemoryHandle").finish_non_exhaustive()
    }
}

impl MemoryHandle {
    /// Asks the guest to hold `added_mib` above the boot RAM: a multiple of
    /// 128 up to the capacity. A lower value shrinks. Returns once the target
    /// is published; poll [`Self::status`] for the guest's progress.
    pub fn request(&self, added_mib: u32) -> Result<()> {
        self.0.request(added_mib)
    }

    /// The current capacity, target, plugged and mapped sizes.
    pub fn status(&self) -> MemoryStatus {
        self.0.status()
    }
}

trait MemoryControl: Send + Sync {
    fn request(&self, added_mib: u32) -> Result<()>;
    fn status(&self) -> MemoryStatus;
}

impl<H: Vm + Send + Sync + 'static> MemoryControl for Mutex<VirtioMem<H>> {
    fn request(&self, added_mib: u32) -> Result<()> {
        let mut device = self.lock().unwrap_or_else(PoisonError::into_inner);
        let bytes = u64::from(added_mib) * MIB;
        if !bytes.is_multiple_of(SLOT_SIZE) || bytes > device.memory.size() {
            return Err(Error::InvalidHotplugSize(added_mib));
        }
        device.requested = bytes;
        if let Some(ctx) = &device.context {
            ctx.interrupt.raise_config();
        }
        Ok(())
    }

    fn status(&self) -> MemoryStatus {
        let device = self.lock().unwrap_or_else(PoisonError::into_inner);
        let mib = |bytes: u64| (bytes / MIB) as u32;
        MemoryStatus {
            capacity_mib: mib(device.memory.size()),
            requested_mib: mib(device.requested),
            plugged_mib: mib(device.memory.plugged_bytes()),
            mapped_mib: mib(device.memory.mapped_bytes()),
        }
    }
}

/// The virtio-mem device and the hotplug window it drives.
pub(crate) struct VirtioMem<H: Vm + ?Sized> {
    memory: HotplugMemory<H>,
    requested: u64,
    features: u64,
    context: Option<ActivationContext>,
}

/// Adds the device on `slot` and returns its host handle.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn add<H: Vm + Send + Sync + 'static>(
    chipset: &mut crate::chipset::ChipsetBuilder,
    ctx: &crate::virtio::DeviceContext<'_>,
    slot: crate::virtio::mmio::Slot,
    memory: HotplugMemory<H>,
) -> Result<MemoryHandle> {
    let device = Arc::new(Mutex::new(VirtioMem::new(memory)));
    crate::virtio::mmio::add_device(chipset, ctx, SPEC.name, slot, device.clone())?;
    Ok(MemoryHandle(device))
}

impl<H: Vm + ?Sized> VirtioMem<H> {
    pub(crate) fn new(memory: HotplugMemory<H>) -> Self {
        Self {
            memory,
            requested: 0,
            features: 0,
            context: None,
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
        if self.context.is_some()
            || self.features & UNPLUGGED_INACCESSIBLE == 0
            || ctx.queues.len() != 1
            || !ctx.queues.is_ready(0)
        {
            return Err(DeviceError::NeedsReset("virtio-mem activation"));
        }
        self.context = Some(ctx);
        Ok(())
    }

    fn reset(&mut self) -> std::result::Result<(), DeviceError> {
        // Plugged blocks survive a reset: a reprobing driver unplugs them all.
        self.features = 0;
        self.context = None;
        Ok(())
    }

    fn on_event(&mut self, event: DeviceEvent) -> std::result::Result<(), DeviceError> {
        let DeviceEvent::QueueKick(0) = event else {
            return Err(DeviceError::Unsupported("virtio-mem event"));
        };
        let mut ctx = self
            .context
            .take()
            .ok_or(DeviceError::NeedsReset("inactive virtio-mem"))?;
        let result = ctx.queues.drain(0, |chain| self.request(chain));
        let interrupt = Arc::clone(&ctx.interrupt);
        self.context = Some(ctx);
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
