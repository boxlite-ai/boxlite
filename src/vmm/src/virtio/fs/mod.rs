// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! In-process virtio-fs: a FUSE session over one priority and one request queue.
//!
//! The immutable aggregate root exposes all shares through this one device.
//! Host file I/O is synchronous. Under the shared executor a slow request also
//! stalls other device callbacks. The VM registers this device through the common
//! MMIO transport and worker runtime.

use std::sync::{Arc, Mutex};

use self::device::Fs;
use super::{
    DeviceContext, VirtioDevice,
    mmio::{self, Slot},
};
use crate::{
    chipset::ChipsetBuilder,
    config::FsConfig,
    error::{Error, Result},
};

pub(crate) mod aggregate;
pub(crate) mod descriptor;
pub(crate) mod device;
pub(crate) mod filesystem;
pub(crate) mod fuse;
mod linux;
mod multikey;
pub(crate) mod server;

pub(crate) use aggregate::{AggregateFs, Share};

/// Adds the configured exports behind a virtio-mmio transport in `slot`,
/// run by the VM's workers.
pub(crate) fn add_filesystem(
    chipset: &mut ChipsetBuilder,
    ctx: &DeviceContext<'_>,
    config: &FsConfig,
    slot: Slot,
) -> Result<()> {
    let shares = config
        .shares
        .iter()
        .map(|share| Share {
            name: share.name.clone(),
            path: share.path.clone(),
            read_only: share.read_only,
        })
        .collect();
    let filesystem = Fs::new(&config.tag, shares).map_err(Error::Filesystem)?;
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(filesystem));
    mmio::add_device(chipset, ctx, "virtio-fs", slot, device)
}

mod bindings {
    pub(crate) use libc::{ino64_t, stat64, statvfs64};
}

mod fs_utils {
    pub(crate) fn einval() -> std::io::Error {
        std::io::Error::from_raw_os_error(libc::EINVAL)
    }
}

#[cfg(test)]
#[path = "../../../tests/virtio/fs_device.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../tests/virtio/fs_protocol.rs"]
mod protocol_tests;

#[cfg(test)]
#[path = "../../../tests/virtio/fs_backend.rs"]
mod backend_tests;

#[cfg(test)]
#[path = "../../../tests/virtio/fs_linux.rs"]
mod linux_tests;

#[cfg(test)]
#[path = "../../../tests/virtio/fs_worker.rs"]
pub(crate) mod worker_tests;
