// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! In-process virtio-fs: a FUSE session over one priority and one request queue.
//!
//! The immutable aggregate root exposes all shares through this one device.
//! Host file I/O is synchronous. Under the shared executor a slow request also
//! stalls other device callbacks. The VM registers this device through the common
//! MMIO transport and worker runtime.

pub(crate) mod aggregate;
pub(crate) mod descriptor;
pub(crate) mod device;
pub(crate) mod filesystem;
pub(crate) mod fuse;
mod linux;
mod multikey;
pub(crate) mod server;

pub(crate) use aggregate::{AggregateFs, Share};

/// Connects the configured exports to the VM's transport, RAM and workers.
pub(crate) fn add_filesystem(
    chipset: &mut crate::chipset::ChipsetBuilder,
    ctx: &crate::virtio::DeviceContext<'_>,
    config: &crate::config::FsConfig,
    slot: crate::virtio::mmio::Slot,
) -> crate::error::Result<()> {
    use std::sync::{Arc, Mutex};

    let shares = config
        .shares
        .iter()
        .map(|share| Share {
            name: share.name.clone(),
            path: share.path.clone(),
            read_only: share.read_only,
        })
        .collect();
    let device = device::Fs::new(&config.tag, shares).map_err(crate::error::Error::Filesystem)?;
    crate::virtio::mmio::add_device(
        chipset,
        ctx,
        "virtio-fs",
        slot,
        Arc::new(Mutex::new(device)),
    )
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
