// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! In-process virtio-fs: a FUSE session over one priority and one request queue.
//!
//! The aggregate root exposes independently registered shares through one device.
//! Host file I/O is synchronous. Under the shared executor a slow request also
//! stalls other device callbacks. The VM registers this device through the common
//! MMIO transport and worker runtime.

use std::sync::{Arc, LazyLock, Mutex};

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

pub use aggregate::{AggregateFs, Share};

use std::collections::BTreeMap;

/// Live aggregate filesystems keyed by device tag. The shim process hosts
/// one VM; the mount-control server reaches the device through this registry
/// instead of threading device internals through the transport. The entry
/// appears when the device is built and is removed when the device drops, so
/// a torn-down VM releases its exports instead of pinning them to process
/// exit; lookups after teardown answer `ENODEV`.
static MOUNT_DEVICES: LazyLock<Mutex<BTreeMap<String, Arc<AggregateFs>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

fn mount_devices() -> &'static Mutex<BTreeMap<String, Arc<AggregateFs>>> {
    &MOUNT_DEVICES
}

/// The live aggregate filesystem for `tag`, or `ENODEV` when no device with
/// that tag has been built in this process.
pub fn lookup_aggregate(tag: &str) -> std::io::Result<Arc<AggregateFs>> {
    mount_devices()
        .lock()
        .unwrap()
        .get(tag)
        .cloned()
        .ok_or_else(|| std::io::Error::from_raw_os_error(libc::ENODEV))
}

/// Publishes `filesystem` as the live device for `tag`. The VMM build path
/// calls this when the device enters the transport; tests use it to stand up
/// a control server against a real filesystem.
pub fn insert_aggregate(tag: &str, filesystem: Arc<AggregateFs>) {
    mount_devices()
        .lock()
        .unwrap()
        .insert(tag.to_string(), filesystem);
}

/// Removes the registration for `tag` when it still points at `filesystem`
/// and reports whether it did. Tearing down an older device must not
/// unregister a newer rebuild published under the same tag.
pub fn remove_aggregate(tag: &str, filesystem: &AggregateFs) -> bool {
    let mut devices = mount_devices().lock().unwrap();
    match devices.get(tag) {
        Some(live) if std::ptr::eq(live.as_ref(), filesystem) => {
            devices.remove(tag);
            true
        }
        _ => false,
    }
}

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
    insert_aggregate(&config.tag, filesystem.filesystem());
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
