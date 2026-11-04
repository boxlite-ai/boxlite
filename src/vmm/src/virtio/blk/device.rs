// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio block device: the [`VirtioDevice`] contract over one request
//! queue and a [`DiskBackend`].

use super::{
    DEVICE_ID, QUEUE_MAXIMUM, VIRTIO_BLK_F_DISCARD, VIRTIO_BLK_F_FLUSH, VIRTIO_BLK_F_RO,
    VIRTIO_BLK_F_SEG_MAX, VIRTIO_BLK_S_OK,
    backend::{Completed, DiskBackend, Geometry, Outcome, RequestKind},
    config::BlkConfig,
    inflight::Inflight,
    request::{self, Parsed, Targets},
};
use crate::{
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
        SourceId, VirtioDevice,
        mmio::VIRTIO_F_VERSION_1,
        queue::{Completion, VIRTIO_F_INDIRECT_DESC},
    },
};

/// A virtio block device.
pub(crate) struct VirtioBlk {
    spec: DeviceSpec,
    negotiated: u64,
    config: BlkConfig,
    geometry: Geometry,
    backend: Box<dyn DiskBackend>,
    active: Option<Active>,
}

/// What the device holds between DRIVER_OK and the next reset.
struct Active {
    ctx: ActivationContext,
    /// The backend's registered source, when it has one.
    source: Option<SourceId>,
    inflight: Inflight,
    /// Scratch for `completions`, kept so no event allocates.
    completed: Vec<Completed>,
}

impl VirtioBlk {
    /// Builds the device over an open backend.
    ///
    /// A synchronous backend runs every request inside `on_event`, so one
    /// kick does at most the queue size times `MAX_REQUEST_BYTES` of I/O on
    /// the shared worker thread before another device runs.
    pub(crate) fn new(backend: Box<dyn DiskBackend>) -> Self {
        let geometry = backend.geometry();
        let mut features = VIRTIO_F_VERSION_1 | VIRTIO_BLK_F_SEG_MAX | VIRTIO_F_INDIRECT_DESC;
        if geometry.read_only {
            features |= VIRTIO_BLK_F_RO;
        } else {
            features |= VIRTIO_BLK_F_FLUSH | VIRTIO_BLK_F_DISCARD;
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
            config: BlkConfig::new(&geometry),
            geometry,
            backend,
            active: None,
        }
    }

    /// Drains the request queue: every chain is parsed and submitted, and a
    /// chain the backend keeps is deferred until its completion arrives.
    fn process_queue(&mut self) -> Result<(), DeviceError> {
        let (negotiated, geometry) = (self.negotiated, self.geometry);
        let backend = &mut *self.backend;
        let active = self
            .active
            .as_mut()
            .ok_or(DeviceError::NeedsReset("block device is not active"))?;
        let Active { ctx, inflight, .. } = active;
        let memory = ctx.memory.as_ref();
        let notify = ctx.queues.drain(0, |chain| {
            let head = chain.head_index();
            match request::parse(chain, memory, &geometry, negotiated)? {
                Parsed::Immediate { status, targets } => {
                    targets.finish(memory, status, None).map(Completion::Used)
                }
                Parsed::Submit { request, targets } => {
                    let token = inflight.next_token();
                    match backend.submit(token, request) {
                        Outcome::Done(completed) => {
                            complete(memory, &targets, completed).map(Completion::Used)
                        }
                        Outcome::Pending => {
                            inflight.insert(token, head, targets);
                            Ok(Completion::Deferred)
                        }
                    }
                }
            }
        })?;
        if notify {
            ctx.interrupt.raise();
        }
        Ok(())
    }

    /// Completes every deferred chain the backend finished.
    fn backend_ready(&mut self, id: SourceId) -> Result<(), DeviceError> {
        let backend = &mut *self.backend;
        let active = self
            .active
            .as_mut()
            .ok_or(DeviceError::NeedsReset("block device is not active"))?;
        if active.source != Some(id) {
            return Ok(());
        }
        let Active {
            ctx,
            inflight,
            completed,
            ..
        } = active;
        let memory = ctx.memory.as_ref();
        let mut notify = false;
        loop {
            backend.completions(completed);
            if completed.is_empty() {
                break;
            }
            for done in completed.drain(..) {
                let (head, targets) = inflight
                    .remove(done.token)
                    .ok_or(DeviceError::NeedsReset("block completion token"))?;
                let used = complete(memory, &targets, done)?;
                notify |= ctx.queues.complete(0, head, used)?;
            }
        }
        if notify {
            ctx.interrupt.raise();
        }
        Ok(())
    }
}

/// Writes a finished request's results to its targets and returns the used
/// length: the data and status of a successful read, else the status alone.
fn complete(
    memory: &GuestMemoryMmap,
    targets: &Targets,
    completed: Completed,
) -> Result<u32, DeviceError> {
    let data = match (&completed.request.kind, completed.status) {
        (RequestKind::In { buf, .. }, VIRTIO_BLK_S_OK) => Some(buf.as_slice()),
        _ => None,
    };
    targets.finish(memory, completed.status, data)
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

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        if self.active.is_some() {
            return Err(DeviceError::NeedsReset("block device is already active"));
        }
        if !ctx.queues.is_ready(0) {
            return Err(DeviceError::NeedsReset("block queue is not ready"));
        }
        let source = match self.backend.event_source() {
            Some(source) => Some(ctx.events.register(source).map_err(|error| {
                tracing::warn!(%error, "the block backend source was not registered");
                DeviceError::NeedsReset("block backend source")
            })?),
            None => None,
        };
        self.active = Some(Active {
            ctx,
            source,
            inflight: Inflight::default(),
            completed: Vec::new(),
        });
        Ok(())
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.negotiated = 0;
        if let Some(active) = self.active.take() {
            if let Some(id) = active.source {
                active.ctx.events.deregister(id);
            }
            // The worker is stopped, so no completion can arrive, and the
            // guest may reuse the memory a request in flight would write: a
            // backend that still holds one cannot continue. A bounded wait
            // comes with the first asynchronous engine.
            if !active.inflight.is_empty() {
                return Err(DeviceError::Fatal("block requests in flight at reset"));
            }
        }
        self.backend
            .flush()
            .map_err(|_| DeviceError::Fatal("block flush"))
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        match event {
            DeviceEvent::QueueKick(0) => self.process_queue(),
            DeviceEvent::QueueKick(_) => Err(DeviceError::Unsupported("block queue index")),
            DeviceEvent::BackendReady(id) => self.backend_ready(id),
        }
    }

    fn quiesce(&mut self) -> Result<(), DeviceError> {
        self.backend
            .flush()
            .map_err(|_| DeviceError::Fatal("block flush"))
    }
}
