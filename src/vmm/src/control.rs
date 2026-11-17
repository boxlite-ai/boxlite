// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Host operations routed to devices by their configured IDs.

use std::{collections::HashMap, io, sync::Arc, time::Duration};

use crate::virtio::blk::control::{self, Controls, DiskSender};

/// Controls a VM from any thread without exposing its devices.
#[derive(Clone, Debug)]
pub struct VmControl {
    disks: Arc<HashMap<String, DiskSender>>,
}

impl VmControl {
    /// Grows the named writable disk to `bytes`, returning its capacity.
    /// The target must be sector aligned and no smaller than its current
    /// capacity. Actual growth notifies the guest; the current size is a no-op.
    ///
    /// Unknown IDs return `InvalidInput`. A request before device activation
    /// waits for activation. A timeout does not cancel an enqueued request;
    /// retrying the same absolute target is safe. A dropped device returns
    /// `BrokenPipe`.
    pub fn resize_disk(&self, block_id: &str, bytes: u64, timeout: Duration) -> io::Result<u64> {
        self.disks
            .get(block_id)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, format!("no disk {block_id:?}"))
            })?
            .grow(bytes, timeout)
    }
}

/// Mutable only while the VM's devices are being built.
#[derive(Default)]
pub(crate) struct ControlRegistry {
    disks: HashMap<String, DiskSender>,
}

impl ControlRegistry {
    pub(crate) fn register_disk(&mut self, block_id: &str) -> io::Result<Controls> {
        use std::collections::hash_map::Entry;

        let Entry::Vacant(entry) = self.disks.entry(block_id.to_owned()) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("duplicate disk ID {block_id:?}"),
            ));
        };
        let (sender, controls) = control::channel()?;
        entry.insert(sender);
        Ok(controls)
    }

    pub(crate) fn finish(self) -> VmControl {
        VmControl {
            disks: Arc::new(self.disks),
        }
    }
}
