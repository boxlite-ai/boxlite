//! Storage operations (volume mounting).
//!
//! Provides unified abstraction for mounting different volume types:
//! - Virtiofs: Host-shared directories via virtio-fs
//! - Block devices: Disk images attached via virtio-blk

mod aggregate;
pub(crate) mod attach;
pub mod block_device;
pub mod fsfreeze;
pub mod idmap;
pub(crate) mod resolved_mount;
mod virtiofs;
mod volume;

pub(crate) use aggregate::aggregate_root;
pub(crate) use aggregate::mount_volumes as mount_initial_volumes;
pub use volume::mount_volumes;
