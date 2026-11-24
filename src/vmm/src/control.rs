// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Runtime controls for a VM.

use std::{collections::HashMap, io, path::Path, sync::Arc, time::Duration};

use crate::{
    MemoryStatus,
    error::Result,
    lifecycle::{Lifecycle, VmStatus},
    virtio::blk::control::{self, Controls, DiskSender},
};

mod memory;
pub(crate) use memory::{MemoryRequest, MemoryRequests};

/// Controls a VM from any thread without exposing its devices.
/// Dropping a control handle has no effect on execution.
#[derive(Clone, Debug)]
pub struct VmControl {
    disks: Arc<HashMap<String, DiskSender>>,
    memory: Option<memory::MemorySender>,
    lifecycle: Arc<Lifecycle>,
}

impl VmControl {
    /// Returns the current lifecycle state.
    pub fn status(&self) -> VmStatus {
        self.lifecycle.status()
    }

    /// Requests a stop, including before execution starts, without waiting for exit.
    pub fn stop(&self) {
        self.lifecycle.stop();
    }

    /// Reserves an initial pause in `Created`, or posts a pause request for a
    /// running device-less VM and wakes the run driver without waiting. Callers
    /// can observe completion with [`Self::wait_paused`].
    pub fn request_pause(&self) -> Result<()> {
        self.lifecycle.request_pause()
    }

    /// Reopens guest entry for a paused VM after the run driver accepts it.
    pub fn resume(&self) -> Result<()> {
        self.lifecycle.resume()
    }

    /// Exports a paused device-less VM on Linux x86_64 to new state and raw RAM files.
    /// Both files are created with mode `0600`.
    /// Export skips `fsync`, and dropping the files ignores delayed `close(2)` errors.
    /// `Ok(())` provides no guarantee of power-loss durability.
    ///
    /// Callers must have exclusive use of both target paths during export. Failure
    /// cleanup is best-effort and attempts to unlink a path only if its device and
    /// inode still match the open file.
    pub fn export(
        &self,
        state_path: impl AsRef<Path>,
        memory_path: impl AsRef<Path>,
    ) -> Result<()> {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            self.lifecycle
                .submit_export(state_path.as_ref(), memory_path.as_ref())?
                .recv()
                .unwrap_or_else(|_| Err(crate::lifecycle::export_terminated()))
        }
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        {
            let _ = (state_path, memory_path);
            Err(crate::Error::Control {
                operation: "export",
                reason: crate::ControlReason::Unsupported,
            })
        }
    }

    /// Waits for the current pause epoch, including a reserved or queued pause.
    /// A zero timeout checks the current condition while holding the lock.
    ///
    /// `Ok(())` confirms that the target pause epoch completed; callers that
    /// need the VM to stay quiescent must serialize against concurrent
    /// [`Self::resume`] calls on cloned handles.
    pub fn wait_paused(&self, timeout: Duration) -> Result<()> {
        self.lifecycle.wait_paused(timeout)
    }

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

    /// Sets the hotplug target above boot RAM, in MiB. Success means the
    /// effective target was published; the guest plugs or unplugs afterward.
    /// An inactive device or full queue returns `WouldBlock`. A timeout
    /// does not cancel an admitted command.
    pub fn set_memory_target_mib(&self, added_mib: u32, timeout: Duration) -> io::Result<()> {
        self.memory()?
            .request(timeout, |reply| MemoryRequest::SetTarget {
                added_mib,
                reply,
            })
    }

    /// Reads hotplug capacity, target, and actual sizes from the active device.
    pub fn memory_status(&self, timeout: Duration) -> io::Result<MemoryStatus> {
        self.memory()?.request(timeout, MemoryRequest::Status)
    }

    fn memory(&self) -> io::Result<&memory::MemorySender> {
        self.memory.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "the VM has no virtio-mem device",
            )
        })
    }

    pub(crate) fn close_memory(&self) {
        if let Some(memory) = &self.memory {
            memory.close();
        }
    }
}

/// Mutable only while the VM's devices are being built.
#[derive(Default)]
pub(crate) struct ControlRegistry {
    disks: HashMap<String, DiskSender>,
    memory: Option<memory::MemorySender>,
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

    pub(crate) fn finish(self, lifecycle: Arc<Lifecycle>) -> VmControl {
        VmControl {
            disks: Arc::new(self.disks),
            memory: self.memory,
            lifecycle,
        }
    }

    #[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
    pub(crate) fn register_memory(&mut self) -> io::Result<MemoryRequests> {
        if self.memory.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the VM already has a memory control endpoint",
            ));
        }
        let (sender, requests) = memory::channel();
        self.memory = Some(sender);
        Ok(requests)
    }
}

#[cfg(all(test, not(all(target_os = "linux", target_arch = "x86_64"))))]
#[path = "../tests/snapshot/image.rs"]
mod snapshot_tests;
