//! Rootfs management
//!
//! This module handles rootfs preparation and management for boxes.

#[cfg(unix)]
mod builder;
#[cfg(unix)]
mod copy_mount;
pub(crate) mod guest;
pub(crate) mod operations;

#[cfg(unix)]
pub use builder::RootfsBuilder;
#[cfg(unix)]
pub use copy_mount::{CopyMode, CopyMountOptions, copy_based_mount};
