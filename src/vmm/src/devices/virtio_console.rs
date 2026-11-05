// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! One output-only virtio console port, sharing the serial console's queue.
//!
//! TX completion waits only for a copy into the bounded host queue, never for
//! its sink. The VM wiring that owns this device's lifecycle and final TX scan
//! follows separately.

use std::io::Write;

use virtio_queue::{DescriptorChain, desc::split::Descriptor};
use vm_memory::{Address, Bytes, GuestMemoryBackend};

use super::console::ConsoleWriter;
use crate::{
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
        VirtioDevice, queue::Completion,
    },
};

const QUEUE_SIZE: usize = 256;
const TX: usize = 1;
/// Bytes copied between guest RAM and the host queue per iteration.
const CHUNK_BYTES: usize = 4096;
const SPEC: DeviceSpec = DeviceSpec {
    device_id: 3,
    name: "virtio-console",
    features: 0,
    config_len: 12,
    queue_max: &[QUEUE_SIZE as u16, QUEUE_SIZE as u16],
    snapshot: SnapshotSupport::Unsupported,
};

pub(crate) struct VirtioConsole {
    writer: ConsoleWriter,
    activation: Option<ActivationContext>,
    /// A failed ring or uncertain completion must not be retried before reset.
    broken: bool,
    /// Set by [`VirtioDevice::quiesce`]: new kicks are ignored until activation.
    stopped: bool,
}

impl VirtioConsole {
    /// Builds the port over a writer shared with the serial console.
    pub(crate) fn new(writer: ConsoleWriter) -> Self {
        Self {
            writer,
            activation: None,
            broken: false,
            stopped: false,
        }
    }

    /// Scans pending TX once, then releases queue and RAM references, even on
    /// error. The caller must first stop all vCPUs and device dispatch; scanning
    /// from Drop or racing the executor could replay output or touch retired RAM.
    /// The shared host console worker is finished separately, after this call.
    pub(crate) fn finish_tx(&mut self) -> Result<(), DeviceError> {
        let result = if self.broken { Ok(()) } else { self.transmit() };
        self.activation = None;
        self.stopped = false;
        result
    }

    /// Validates and copies every available TX chain, then publishes the used
    /// entries for the heads it accepted, even if a later head failed.
    fn transmit(&mut self) -> Result<(), DeviceError> {
        let Some(ctx) = self.activation.as_mut() else {
            return Ok(());
        };
        if self.broken {
            return Err(DeviceError::NeedsReset("virtio-console TX"));
        }
        let mut heads = [0u16; QUEUE_SIZE];
        let mut count = 0;
        // Reused across chains: a console batch can hold many tiny heads, so
        // the snapshot and copy buffers are allocated once per kick.
        let mut descriptors = [Descriptor::default(); QUEUE_SIZE];
        let mut buffer = [0u8; CHUNK_BYTES];
        let writer = &mut self.writer;
        let memory = &ctx.memory;
        // Defer used publication until drain returns: if a later head is
        // malformed, complete the earlier heads and resolve their notifications
        // anyway. drain's inline Used path loses that decision on an error.
        let mut result = ctx.queues.drain(TX, |chain| {
            let head = chain.head_index();
            if count == heads.len() || heads[..count].contains(&head) {
                return Err(DeviceError::NeedsReset("virtio-console TX head"));
            }
            copy_tx(chain, memory, writer, &mut descriptors, &mut buffer)?;
            heads[count] = head;
            count += 1;
            Ok(Completion::Deferred)
        });
        for head in &heads[..count] {
            match ctx.queues.complete(TX, *head, 0) {
                Ok(true) => ctx.interrupt.raise(),
                Ok(false) => {}
                Err(error) => {
                    // Keep the first failure, but attempt the remaining heads.
                    if result.is_ok() {
                        result = Err(error);
                    }
                }
            }
        }
        self.broken = result.is_err();
        result.map(|_| ())
    }
}

impl VirtioDevice for VirtioConsole {
    fn spec(&self) -> &DeviceSpec {
        &SPEC
    }

    /// Accepts no device-specific feature bits.
    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        if negotiated != 0 {
            return Err(FeatureError {
                unsupported: negotiated,
            });
        }
        Ok(())
    }

    /// Reports the all-zero 12-byte console configuration.
    fn read_config(&mut self, _offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        data.fill(0);
        Ok(())
    }

    /// Accepts and ignores configuration writes.
    fn write_config(&mut self, _offset: u64, _data: &[u8]) -> Result<(), DeviceError> {
        Ok(())
    }

    /// Takes the queues once; TX must be ready and RX is not required.
    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        if self.activation.is_some() || !ctx.queues.is_ready(TX) {
            return Err(DeviceError::NeedsReset("virtio-console activation"));
        }
        self.activation = Some(ctx);
        self.broken = false;
        self.stopped = false;
        Ok(())
    }

    /// Drops activation and failed state but keeps the shared writer.
    fn reset(&mut self) -> Result<(), DeviceError> {
        self.activation = None;
        self.broken = false;
        self.stopped = false;
        Ok(())
    }

    /// Processes a TX kick unless the device is quiesced or finished.
    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        if event == DeviceEvent::QueueKick(TX as u16) && !self.stopped {
            self.transmit()?;
        }
        Ok(())
    }

    /// Stops accepting kicks; [`Self::finish_tx`] still scans pending TX.
    fn quiesce(&mut self) -> Result<(), DeviceError> {
        self.stopped = true;
        Ok(())
    }
}

/// Capture metadata once: a second guest descriptor traversal could differ from
/// the one validated. Both metadata and the copy buffer have host-fixed sizes.
fn copy_tx(
    mut chain: DescriptorChain<&GuestMemoryMmap>,
    memory: &GuestMemoryMmap,
    writer: &mut ConsoleWriter,
    descriptors: &mut [Descriptor; QUEUE_SIZE],
    buffer: &mut [u8; CHUNK_BYTES],
) -> Result<(), DeviceError> {
    let mut count = 0;
    for descriptor in chain.by_ref() {
        let Some(slot) = descriptors.get_mut(count) else {
            return Err(DeviceError::NeedsReset("virtio-console TX chain"));
        };
        let len = descriptor.len() as usize;
        if descriptor.is_write_only()
            || (len != 0
                && (descriptor.addr().checked_add(len as u64).is_none()
                    || !memory.check_range(descriptor.addr(), len)))
        {
            return Err(DeviceError::NeedsReset("virtio-console TX chain"));
        }
        *slot = descriptor;
        count += 1;
    }
    // The upstream iterator silently ends on malformed traversal or aggregate
    // length overflow; a valid direct chain must end on a terminal descriptor.
    if count == 0 || descriptors[count - 1].has_next() {
        return Err(DeviceError::NeedsReset("virtio-console TX chain"));
    }
    for descriptor in &descriptors[..count] {
        let mut address = descriptor.addr();
        let mut remaining = descriptor.len() as usize;
        while remaining != 0 {
            let len = remaining.min(buffer.len());
            memory
                .read_slice(&mut buffer[..len], address)
                .map_err(|_| DeviceError::NeedsReset("virtio-console TX memory"))?;
            writer
                .write_all(&buffer[..len])
                .map_err(|_| DeviceError::Fatal("virtio-console output queue"))?;
            address = address
                .checked_add(len as u64)
                .ok_or(DeviceError::NeedsReset("virtio-console TX memory"))?;
            remaining -= len;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/virtio_console/mod.rs"]
mod tests;
