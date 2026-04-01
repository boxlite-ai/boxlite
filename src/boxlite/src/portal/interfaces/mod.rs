//! Service interfaces.
//!
//! High-level facades over gRPC services.

pub mod container;
pub mod exec;
pub mod files;
pub mod guest;

pub use container::{ContainerInterface, ContainerRootfsInitConfig};
pub use exec::ExecutionInterface;
pub use files::FilesInterface;
pub use guest::{GuestInitConfig, GuestInterface, NetworkInitConfig, VolumeConfig};
