//! Volume management for guest VM and containers.
//!
//! Provides:
//! - `GuestVolumeManager` for virtiofs shares and block devices
//! - `ContainerVolumeManager` for container bind mounts
//! - `VolumeInfo`/`VolumeState` metadata for named volumes (REST-backed; no
//!   local backend yet)

mod container_volume;
mod guest_volume;
mod share;
mod staging;
mod store;

pub use container_volume::{ContainerMount, ContainerVolumeManager};
pub use guest_volume::GuestVolumeManager;
pub use share::{VolumeShare, classify_volume_share};
pub use staging::stage_single_file;
pub use store::{VolumeInfo, VolumeState};
