// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio block device contract implementation.

use std::sync::Arc;

use virtio_queue::QueueT;

use super::{
    DEVICE_ID, QUEUE_MAXIMUM, VIRTIO_BLK_F_DISCARD, VIRTIO_BLK_F_FLUSH, VIRTIO_BLK_F_RO,
    VIRTIO_BLK_F_SEG_MAX, VIRTIO_BLK_F_WRITE_ZEROES, VIRTIO_F_VERSION_1, VIRTIO_RING_F_EVENT_IDX,
    backend::BlkBackend, config::BlkConfig, request,
};
use crate::virtio::{
    ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
    VirtioDevice, queue,
};

/// A virtio block device.
pub(crate) struct VirtioBlk {
    spec: DeviceSpec,
    negotiated: u64,
    config: BlkConfig,
    backend: BlkBackend,
    active: Option<ActivationContext>,
}

impl VirtioBlk {
    /// Builds the device for an already opened backend.
    pub(crate) fn new(backend: BlkBackend) -> Self {
        let read_only = backend.read_only();
        let mut features = VIRTIO_F_VERSION_1 | VIRTIO_BLK_F_SEG_MAX | VIRTIO_RING_F_EVENT_IDX;
        if read_only {
            features |= VIRTIO_BLK_F_RO;
        } else {
            features |= VIRTIO_BLK_F_FLUSH | VIRTIO_BLK_F_DISCARD | VIRTIO_BLK_F_WRITE_ZEROES;
        }
        Self {
            spec: DeviceSpec {
                device_id: DEVICE_ID,
                name: "block",
                features,
                config_len: super::config::LEN,
                queue_max: QUEUE_MAXIMUM,
                snapshot: SnapshotSupport::Unsupported,
            },
            negotiated: 0,
            config: BlkConfig::new(
                backend.capacity_sectors(),
                backend.discard_sector_alignment(),
            ),
            backend,
            active: None,
        }
    }

    fn event_idx(&self) -> bool {
        self.negotiated & VIRTIO_RING_F_EVENT_IDX != 0
    }

    fn process_queue(&mut self) -> Result<(), DeviceError> {
        let negotiated = self.negotiated;
        let backend = &mut self.backend;
        let ctx = self
            .active
            .as_mut()
            .ok_or(DeviceError::NeedsReset("block device is not active"))?;
        let memory = Arc::clone(&ctx.memory);
        let drain_memory = Arc::clone(&ctx.memory);
        let notify = queue::drain(&mut ctx.queues[0], &drain_memory, false, move |chain| {
            request::execute(chain, backend, negotiated, &memory)
        })?;
        if notify {
            ctx.interrupt.raise();
        }
        Ok(())
    }
}

impl VirtioDevice for VirtioBlk {
    fn spec(&self) -> &DeviceSpec {
        &self.spec
    }

    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        let unsupported = negotiated & !self.spec.features;
        if unsupported != 0 {
            return Err(FeatureError { unsupported });
        }
        self.negotiated = negotiated;
        Ok(())
    }

    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        self.config.read(offset, data);
        Ok(())
    }

    fn write_config(&mut self, _offset: u64, _data: &[u8]) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("block configuration write"))
    }

    fn activate(&mut self, mut ctx: ActivationContext) -> Result<(), DeviceError> {
        if self.active.is_some() {
            return Err(DeviceError::NeedsReset("block device is already active"));
        }
        queue::prepare_all(
            &mut ctx.queues,
            self.spec.queue_max,
            self.event_idx(),
            &ctx.memory,
        )?;
        if !ctx.queues.first().is_some_and(|queue| queue.ready()) {
            return Err(DeviceError::NeedsReset("block queue is not ready"));
        }
        self.active = Some(ctx);
        Ok(())
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.active = None;
        self.negotiated = 0;
        self.backend
            .flush()
            .map_err(|_| DeviceError::Fatal("block flush"))
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        match event {
            DeviceEvent::QueueKick(0) => self.process_queue(),
            DeviceEvent::QueueKick(_) => Err(DeviceError::Unsupported("block queue index")),
            DeviceEvent::BackendReady(_) => Ok(()),
        }
    }

    fn quiesce(&mut self) -> Result<(), DeviceError> {
        self.backend
            .flush()
            .map_err(|_| DeviceError::Fatal("block flush"))
    }
}
