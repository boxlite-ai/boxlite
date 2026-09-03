//! Rootfs management
//!
//! This module handles rootfs preparation and management for boxes.

mod builder;
mod copy_mount;
pub(crate) mod guest;
pub(crate) mod operations;
mod overlay_merge;

pub use builder::RootfsBuilder;
pub use copy_mount::{CopyMode, CopyMountOptions, copy_based_mount};
