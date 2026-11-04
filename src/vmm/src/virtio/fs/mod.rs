// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! In-process virtio-fs: a FUSE session over one priority and one request queue.
//!
//! The immutable aggregate root exposes all shares through this one device.
//! Host file I/O is synchronous. Under the shared executor a slow request also
//! stalls other device callbacks. Machine registration and guest mounts are PR2.

pub(crate) mod aggregate;
pub(crate) mod descriptor;
pub(crate) mod device;
pub(crate) mod filesystem;
pub(crate) mod fuse;
mod linux;
mod multikey;
pub(crate) mod server;

pub(crate) use aggregate::{AggregateFs, Share};

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
