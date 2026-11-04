// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io;

use super::{AggregateFs, Share, descriptor::request_buffers, server::Server};
use crate::virtio::{
    ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
    VirtioDevice,
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
    snapshot: SnapshotSupport::Unsupported,
};

/// One immutable share registry and one FUSE session, independent of transport.
///
/// Reset releases the session's file handles and lookup references before the
/// transport can replace guest RAM. It retains the export configuration.
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
        let memory = &ctx.memory;
        let interrupt = ctx.queues.drain(usize::from(index), |chain| {
            let (reader, writer) = request_buffers(memory.as_ref(), chain)
                .map_err(|_| DeviceError::NeedsReset("virtio-fs request descriptors"))?;
            let written = server.handle_message(reader, writer).map_err(|error| {
                tracing::warn!(%error, "virtio-fs request failed");
                DeviceError::NeedsReset("virtio-fs request buffers")
            })?;
            let written = u32::try_from(written)
                .map_err(|_| DeviceError::NeedsReset("virtio-fs reply size"))?;
            Ok(Completion::Used(written))
        })?;
        if interrupt {
            ctx.interrupt.raise();
        }
        Ok(())
    }
}
