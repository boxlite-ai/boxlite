// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io;
use std::sync::Arc;

use super::{AggregateFs, Share, descriptor::request_buffers, server::Server, state};
use crate::memory::GuestMemoryMmap;
use crate::virtio::{
    ActivationContext, DeviceError, DeviceEvent, DeviceSnapshot, DeviceSpec, FeatureError,
    RestoreContext, SnapshotError, SnapshotSupport, VirtioDevice,
    queue::{Completion, VIRTIO_F_EVENT_IDX},
};

const TAG_LEN: usize = 36;
const CONFIG_LEN: usize = TAG_LEN + size_of::<u32>();
const QUEUE_MAX: &[u16] = &[1024, 1024];
const SPEC: DeviceSpec = DeviceSpec {
    device_id: 26,
    name: "virtio-fs",
    features: VIRTIO_F_EVENT_IDX,
    config_len: CONFIG_LEN,
    queue_max: QUEUE_MAX,
    snapshot: SnapshotSupport::Stopped,
};

/// One dynamic share registry and one FUSE session, independent of transport.
///
/// Reset releases the session's file handles and lookup references before the
/// transport can replace guest RAM. It retains the export configuration.
/// Quiescing keeps the whole session for a snapshot; only the mount registry
/// stays frozen until resume.
pub(crate) struct Fs {
    config: [u8; CONFIG_LEN],
    features: u64,
    server: Server<AggregateFs>,
    activation: Option<ActivationContext>,
}

impl Fs {
    pub(crate) fn new(tag: &str, shares: Vec<Share>) -> io::Result<Self> {
        if tag.is_empty() || tag.len() > TAG_LEN || tag.as_bytes().contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "virtio-fs tag must contain 1..=36 UTF-8 bytes without NUL",
            ));
        }
        let mut config = [0; CONFIG_LEN];
        config[..tag.len()].copy_from_slice(tag.as_bytes());
        config[TAG_LEN..].copy_from_slice(&1u32.to_le_bytes());
        Ok(Self {
            config,
            features: 0,
            server: Server::new(AggregateFs::new(shares)?),
            activation: None,
        })
    }

    /// The aggregate filesystem this device serves, shared with the
    /// process-wide mount registry for the control socket.
    pub(crate) fn filesystem(&self) -> Arc<AggregateFs> {
        self.server.filesystem()
    }

    /// The tag this device was built with. It is also the key of its entry in
    /// the process mount registry and the name a saved state is checked against.
    fn tag(&self) -> &str {
        let bytes = &self.config[..TAG_LEN];
        let len = bytes.iter().position(|byte| *byte == 0).unwrap_or(TAG_LEN);
        // `new` admits only valid UTF-8 without NUL, so the tag cannot fail to decode.
        std::str::from_utf8(&bytes[..len]).expect("the tag was validated at construction")
    }
}

impl Drop for Fs {
    fn drop(&mut self) {
        // Unpublish only this device's registration, then close its session
        // even when a control operation still holds a filesystem reference.
        super::remove_aggregate(self.tag(), &self.server.filesystem());
        self.server.reset();
    }
}

impl VirtioDevice for Fs {
    fn spec(&self) -> &DeviceSpec {
        &SPEC
    }

    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        let unsupported = negotiated & !SPEC.features;
        if unsupported != 0 {
            return Err(FeatureError { unsupported });
        }
        self.features = negotiated;
        Ok(())
    }

    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        let offset = usize::try_from(offset)
            .map_err(|_| DeviceError::NeedsReset("virtio-fs configuration offset"))?;
        let end = offset
            .checked_add(data.len())
            .ok_or(DeviceError::NeedsReset("virtio-fs configuration range"))?;
        let config = self
            .config
            .get(offset..end)
            .ok_or(DeviceError::NeedsReset("virtio-fs configuration range"))?;
        data.copy_from_slice(config);
        Ok(())
    }

    fn write_config(&mut self, _offset: u64, _data: &[u8]) -> Result<(), DeviceError> {
        // The virtio-fs configuration is entirely device-owned.
        Ok(())
    }

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        if self.activation.is_some() {
            return Err(DeviceError::NeedsReset("virtio-fs already active"));
        }
        if ctx.queues.len() != QUEUE_MAX.len()
            || QUEUE_MAX.iter().enumerate().any(|(index, max)| {
                !ctx.queues.is_ready(index) || ctx.queues.max_size(index) != Some(*max)
            })
        {
            return Err(DeviceError::NeedsReset("virtio-fs requires both queues"));
        }
        self.activation = Some(ctx);
        Ok(())
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.server.reset();
        self.activation = None;
        self.features = 0;
        Ok(())
    }

    fn quiesce(&mut self) -> Result<(), DeviceError> {
        // A snapshot needs the session exactly as it is. Reset and drop close it.
        self.server.filesystem().freeze();
        Ok(())
    }

    fn save_state(&self) -> Result<DeviceSnapshot, SnapshotError> {
        self.server
            .filesystem()
            .export_state(self.tag(), self.server.handshake())
            .and_then(|captured| state::encode(&captured))
            .inspect_err(|error| tracing::warn!(%error, "virtio-fs snapshot refused"))
    }

    fn restore_state(
        &mut self,
        snapshot: DeviceSnapshot,
        ctx: RestoreContext,
    ) -> Result<(), DeviceError> {
        if self.activation.is_some() {
            return Err(DeviceError::Unsupported(
                "restoring an active virtio-fs device",
            ));
        }
        if self.server.filesystem().has_exports() {
            return Err(DeviceError::Unsupported(
                "restoring virtio-fs state over configured exports",
            ));
        }
        // The new session is built beside this one; a refused state leaves the device untouched.
        self.server = state::decode(&snapshot, self.tag())
            .and_then(|saved| {
                let handshake = (saved.fuse_initialized, saved.fuse_options);
                AggregateFs::restore(&saved, ctx.exports)
                    .map(|filesystem| Server::with_handshake(filesystem, handshake.0, handshake.1))
                    .map_err(|error| SnapshotError::Refused(error.to_string()))
            })
            .inspect_err(|error| tracing::warn!(%error, "virtio-fs state refused"))
            .map_err(|_| DeviceError::Unsupported("virtio-fs restore_state"))?;
        // The control plane reaches the restored session through the same tag.
        super::insert_aggregate(self.tag(), self.server.filesystem());
        Ok(())
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        let DeviceEvent::QueueKick(index) = event else {
            return Err(DeviceError::NeedsReset(
                "virtio-fs unexpected backend event",
            ));
        };
        let ctx = self
            .activation
            .as_mut()
            .ok_or(DeviceError::NeedsReset("virtio-fs is inactive"))?;
        let server = &self.server;
        let snapshot = vm_memory::GuestAddressSpace::memory(&ctx.memory);
        let memory: &GuestMemoryMmap = &snapshot;
        let mut processed = false;
        let result = ctx.queues.drain(usize::from(index), |chain| {
            let (reader, writer) = request_buffers(memory, chain)
                .map_err(|_| DeviceError::NeedsReset("virtio-fs request descriptors"))?;
            let written = server.handle_message(reader, writer).map_err(|error| {
                tracing::warn!(%error, "virtio-fs request failed");
                DeviceError::NeedsReset("virtio-fs request buffers")
            })?;
            let written = u32::try_from(written)
                .map_err(|_| DeviceError::NeedsReset("virtio-fs reply size"))?;
            processed = true;
            Ok(Completion::Used(written))
        });
        // A later malformed chain must not strand earlier used entries. On
        // error, conservatively notify after processing a chain; drain may
        // have failed while publishing that chain's used entry. Successful
        // batches still honor the queue's normal notification suppression.
        if matches!(&result, Ok(true)) || (result.is_err() && processed) {
            ctx.interrupt.raise();
        }
        result.map(|_| ())
    }

    fn resume(&mut self) -> Result<(), DeviceError> {
        self.server.filesystem().unfreeze();
        Ok(())
    }
}
