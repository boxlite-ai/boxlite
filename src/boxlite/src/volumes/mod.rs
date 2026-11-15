//! Volume management for guest VM and containers.
//!
//! Provides:
//! - `GuestVolumeManager` for virtiofs shares and block devices
//! - `ContainerVolumeManager` for container bind mounts
//! - `VolumeInfo` metadata for named volumes and the local filesystem backend

mod container_volume;
mod guest_volume;
mod local_store;
mod share;
mod staging;
mod store;

pub use container_volume::{ContainerMount, ContainerVolumeManager};
pub use guest_volume::GuestVolumeManager;
pub(crate) use local_store::{LocalVolumeStore, VolumeReferenceMode};
pub use share::{VolumeShare, classify_volume_share};
pub use staging::stage_single_file;
pub use store::VolumeInfo;
