// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Reporting-only balloon: the guest retains its capacity while the host
//! returns backing for isolated free pages. The configured [`ReclaimPolicy`]
//! chooses immediate discard or pressure-driven reclaim. No inflate/deflate
//! target is ever requested.

use std::io;

use virtio_queue::DescriptorChain;
use vm_memory::GuestAddress;

use crate::memory::{GuestMemoryMmap, ReclaimPolicy, ReclaimRange, host_page_size};
use crate::virtio::{
    ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
    VirtioDevice, queue::Completion,
};

const REPORTING: u64 = 1 << 5;
const MAX_DESCRIPTORS: usize = 256;
const MAX_CONTROL_RANGES: usize = 9;
const SPEC: DeviceSpec = DeviceSpec {
    device_id: 5,
    name: "balloon",
    features: REPORTING,
    config_len: 8,
    queue_max: &[256; 3],
    snapshot: SnapshotSupport::Unsupported,
};

pub(crate) struct VirtioBalloon {
    actual: u32,
    features: u64,
    page_size: usize,
    reclaim: ReclaimPolicy,
    context: Option<ActivationContext>,
    control_ranges: [(GuestAddress, usize, usize); MAX_CONTROL_RANGES],
    control_count: usize,
}

impl VirtioBalloon {
    pub(crate) fn new(reclaim: ReclaimPolicy) -> io::Result<Self> {
        Ok(Self {
            actual: 0,
            features: 0,
            page_size: host_page_size()?,
            reclaim,
            context: None,
            control_ranges: [(GuestAddress(0), 0, 0); MAX_CONTROL_RANGES],
            control_count: 0,
        })
    }
}

impl VirtioDevice for VirtioBalloon {
    fn spec(&self) -> &DeviceSpec {
        &SPEC
    }

    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        let unsupported = negotiated & !REPORTING;
        if unsupported != 0 {
            return Err(FeatureError { unsupported });
        }
        self.features = negotiated;
        Ok(())
    }

    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        let mut config = [0; 8];
        config[4..].copy_from_slice(&self.actual.to_le_bytes());
        for (index, byte) in data.iter_mut().enumerate() {
            *byte = offset
                .checked_add(index as u64)
                .and_then(|address| config.get(address as usize))
                .copied()
                .unwrap_or(0);
        }
        Ok(())
    }

    fn write_config(&mut self, offset: u64, data: &[u8]) -> Result<(), DeviceError> {
        let mut actual = self.actual.to_le_bytes();
        for (index, byte) in data.iter().enumerate() {
            if let Some(address @ 4..=7) = offset.checked_add(index as u64) {
                actual[address as usize - 4] = *byte;
            }
        }
        self.actual = u32::from_le_bytes(actual);
        Ok(())
    }

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        if self.context.is_some()
            || ctx.queues.len() != 3
            || !ctx.queues.is_ready(0)
            || !ctx.queues.is_ready(1)
            || (self.features & REPORTING != 0 && !ctx.queues.is_ready(2))
        {
            return Err(DeviceError::NeedsReset("balloon queues"));
        }
        self.control_count = 0;
        for range in ctx.queues.control_ranges() {
            let slot = self
                .control_ranges
                .get_mut(self.control_count)
                .ok_or(DeviceError::NeedsReset("balloon queue control ranges"))?;
            if range.0.0.checked_add(range.1 as u64).is_none() {
                return Err(DeviceError::NeedsReset(
                    "balloon queue control range overflow",
                ));
            }
            let slice =
                vm_memory::GuestMemoryBackend::get_slice(ctx.memory.as_ref(), range.0, range.1)
                    .map_err(|_| DeviceError::NeedsReset("balloon queue control region"))?;
            let host = slice.ptr_guard().as_ptr() as usize;
            host.checked_add(range.1).ok_or(DeviceError::NeedsReset(
                "balloon queue control host overflow",
            ))?;
            *slot = (range.0, range.1, host);
            self.control_count += 1;
        }
        self.context = Some(ctx);
        Ok(())
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.actual = 0;
        self.features = 0;
        self.context = None;
        self.control_ranges.fill((GuestAddress(0), 0, 0));
        self.control_count = 0;
        Ok(())
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        let DeviceEvent::QueueKick(index) = event else {
            return Err(DeviceError::Unsupported("balloon backend event"));
        };
        if index == 2 && self.features & REPORTING == 0 {
            return Ok(());
        }
        let ctx = self
            .context
            .as_mut()
            .ok_or(DeviceError::NeedsReset("inactive balloon"))?;
        let notify = match index {
            0 | 1 => ctx.queues.drain(index as usize, |_| {
                Err(DeviceError::NeedsReset(
                    "reporting-only balloon quota request",
                ))
            })?,
            2 => {
                let controls = &self.control_ranges[..self.control_count];
                let memory = ctx.memory.as_ref();
                let page_size = self.page_size;
                let reclaim = self.reclaim;
                ctx.queues.drain(2, |chain| {
                    report(chain, memory, controls, page_size, reclaim)
                })?
            }
            _ => return Err(DeviceError::NeedsReset("balloon queue index")),
        };
        if notify {
            ctx.interrupt.raise();
        }
        Ok(())
    }
}

fn report(
    mut chain: DescriptorChain<&GuestMemoryMmap>,
    memory: &GuestMemoryMmap,
    controls: &[(GuestAddress, usize, usize)],
    page_size: usize,
    reclaim: ReclaimPolicy,
) -> Result<Completion, DeviceError> {
    let invalid = || DeviceError::NeedsReset("balloon report descriptor");
    let mut ranges = [None; MAX_DESCRIPTORS];
    let mut count = 0;
    let mut terminated = false;
    for descriptor in chain.by_ref() {
        let address = descriptor.addr();
        let len = descriptor.len() as usize;
        if !descriptor.is_write_only() {
            return Err(invalid());
        }
        let end = address.0.checked_add(len as u64).ok_or_else(invalid)?;
        if controls
            .iter()
            .any(|(start, size, _)| address.0 < start.0 + *size as u64 && start.0 < end)
        {
            return Err(invalid());
        }
        let range = ReclaimRange::new(memory, address, len, page_size).map_err(|_| invalid())?;
        let host_end = range.host_start + range.len;
        if range.len != 0
            && controls
                .iter()
                .any(|(_, size, host)| range.host_start < host + size && *host < host_end)
        {
            return Err(invalid());
        }
        *ranges.get_mut(count).ok_or_else(invalid)? = Some((range, address, len));
        count += 1;
        terminated = !descriptor.has_next();
    }
    // The dependency silently ends on bad next indices, exhausted cycle TTL or
    // total-byte overflow. Only a nonempty chain whose final NEXT is clear is
    // normal termination; do not reclaim even a valid prefix otherwise.
    if count == 0 || !terminated {
        return Err(invalid());
    }
    // Metadata, inward HVA arithmetic and both control guards are complete
    // before the first syscall. Preserve descriptor order and duplicates:
    // reclaim is advisory, not released-byte accounting. Other devices/vCPUs
    // can still access RAM, so only volatile handles are retained here; the
    // reporting protocol makes the guest keep these free pages isolated until
    // used. A malicious guest can lose its own data; these guards protect this
    // device's ready queue control ranges even against HVA aliases.
    for (range, address, len) in ranges[..count].iter().flatten() {
        if let Err(error) = range.reclaim(reclaim) {
            tracing::warn!(
                guest_addr = address.0,
                len,
                actual_offset = range.offset,
                actual_len = range.len,
                errno = error.raw_os_error(),
                %error,
                "balloon reporting reclaim failed"
            );
        }
    }
    // Every advice syscall is finished before drain publishes used. Immediate
    // reclaim therefore cannot drop a page after the guest reuses it. Lazy
    // reclaim only marks the range: the kernel drops it under pressure, and a
    // guest write before then cancels the marking.
    Ok(Completion::Used(0))
}

#[cfg(test)]
#[path = "../../tests/virtio/balloon.rs"]
mod tests;
