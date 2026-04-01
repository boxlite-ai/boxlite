//! Volume management for guest VM and containers.
//!
//! Provides:
//! - `GuestVolumeManager` for virtiofs shares and block devices
//! - `ContainerVolumeManager` for container bind mounts

mod container_volume;
mod guest_volume;

pub use container_volume::{ContainerMount, ContainerVolumeManager};
pub use guest_volume::GuestVolumeManager;
