//! Rootfs management
//!
//! This module handles rootfs preparation and management for boxes.

mod builder;
mod copy_mount;
pub(crate) mod guest;
pub(crate) mod operations;

pub use builder::RootfsBuilder;
pub use copy_mount::{CopyMode, CopyMountOptions, copy_based_mount};
