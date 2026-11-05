// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio block device: the [`VirtioDevice`] contract over one request
//! queue and a [`DiskBackend`].

use super::{
    DEVICE_ID, QUEUE_MAXIMUM, VIRTIO_BLK_F_DISCARD, VIRTIO_BLK_F_FLUSH, VIRTIO_BLK_F_RO,
    VIRTIO_BLK_F_SEG_MAX, VIRTIO_BLK_S_OK,
    backend::{CompletedRequest, DiskBackend, DiskInfo, RequestKind, SubmitOutcome},
    config::BlkConfig,
    inflight::Inflight,
    request::{self, Decoded, WriteTargets},
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
    disk_info: DiskInfo,
    backend: Box<dyn DiskBackend>,
    active: Option<ActiveState>,
}

/// What the device holds between DRIVER_OK and the next reset.
struct ActiveState {
    ctx: ActivationContext,
    /// The backend's registered source, when it has one.
    source: Option<SourceId>,
    inflight: Inflight,
    /// Scratch for `completions`, kept so no event allocates.
    completed: Vec<CompletedRequest>,
}

impl VirtioBlk {
    /// Builds the device over an open backend.
    ///
    /// A synchronous backend runs every request inside `on_event`, so one
    /// kick does at most the queue size times `MAX_REQUEST_BYTES` of I/O on
    /// the shared worker thread before another device runs.
    pub(crate) fn new(backend: Box<dyn DiskBackend>) -> Self {
        let disk_info = backend.disk_info();
        let mut features = VIRTIO_F_VERSION_1 | VIRTIO_BLK_F_SEG_MAX | VIRTIO_F_INDIRECT_DESC;
        if disk_info.read_only {
            features |= VIRTIO_BLK_F_RO;
        } else {
            features |= VIRTIO_BLK_F_FLUSH | VIRTIO_BLK_F_DISCARD;
        }
        Self {
            spec: DeviceSpec {
                device_id: DEVICE_ID,
                name: "block",
                features,
                config_len: super::config::CONFIG_LEN,
                queue_max: QUEUE_MAXIMUM,
                snapshot: SnapshotSupport::Unsupported,
            },
            negotiated: 0,
            config: BlkConfig::new(&disk_info),
            disk_info,
            backend,
            active: None,
        }
    }

    /// Drains the request queue: every chain is parsed and submitted, and a
    /// chain the backend keeps is deferred until its completion arrives.
    fn process_queue(&mut self) -> Result<(), DeviceError> {
        let (negotiated, disk_info) = (self.negotiated, self.disk_info);
        let backend = &mut *self.backend;
        let active = self
            .active
            .as_mut()
            .ok_or(DeviceError::NeedsReset("block device is not active"))?;
        let ActiveState { ctx, inflight, .. } = active;
        let memory = ctx.memory.as_ref();
        let notify = ctx.queues.drain(0, |chain| {
            let head = chain.head_index();
            match request::parse(chain, memory, &disk_info, negotiated)? {
                Decoded::Reject { status, targets } => {
                    targets.finish(memory, status, None).map(Completion::Used)
                }
                Decoded::Submit { request, targets } => {
                    let token = inflight.next_token();
                    match backend.submit(token, request) {
                        SubmitOutcome::Done(completed) => {
                            complete_request(memory, &targets, completed).map(Completion::Used)
                        }
                        SubmitOutcome::Pending => {
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
        let ActiveState {
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
                let used = complete_request(memory, &targets, done)?;
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
fn complete_request(
    memory: &GuestMemoryMmap,
    targets: &WriteTargets,
    completed: CompletedRequest,
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
        self.active = Some(ActiveState {
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
