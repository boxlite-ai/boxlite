//! Jailer module for BoxLite security isolation.
//!
//! This module provides defense-in-depth security for the boxlite-shim process,
//! implementing multiple isolation layers inspired by Firecracker's jailer.
//!
//! For the complete security design, see [`THREAT_MODEL.md`](./THREAT_MODEL.md).
//!
//! # Architecture
//!
//! ```text
//! jailer/
//! ├── mod.rs          (public API - this file)
//! ├── builder.rs      (Jailer struct, JailerBuilder)
//! ├── command.rs      (Command building for isolated processes)
//! ├── pre_exec.rs     (Pre-exec hook for process isolation)
//! ├── shim_copy.rs    (Firecracker copy-to-jail pattern)
//! ├── error.rs        (Hierarchical error types)
//! ├── seccomp.rs      (Seccomp BPF filter generation)
//! ├── bwrap.rs        (Bubblewrap command builder)
//! ├── cgroup.rs       (Cgroup v2 setup - Linux only)
//! ├── common/         (Cross-platform utilities)
//! │   ├── fd.rs       (File descriptor cleanup)
//! │   ├── fs.rs       (Filesystem utilities)
//! │   └── rlimit.rs   (Resource limit management)
//! └── platform/       (PlatformIsolation trait)
//!     ├── linux/      (Namespaces, seccomp, chroot)
//!     └── macos/      (sandbox-exec/Seatbelt)
//! ```
//!
//! # Security Layers
//!
//! ## Linux
//! 1. **Namespace isolation** - Mount, PID, network namespaces
//! 2. **Chroot/pivot_root** - Filesystem isolation
//! 3. **Seccomp filtering** - Syscall whitelist
//! 4. **Privilege dropping** - Run as unprivileged user
//! 5. **Resource limits** - cgroups v2, rlimits
//!
//! ## macOS
//! 1. **Sandbox (Seatbelt)** - sandbox-exec with SBPL profile
//! 2. **Resource limits** - rlimits
//!
//! # Usage
//!
//! ```ignore
//! // Using the legacy API
//! let jailer = Jailer::new(&box_id, &box_dir)
//!     .with_security(security);
//!
//! // Or using JailerBuilder (C-BUILDER compliant)
//! let jailer = Jailer::builder()
//!     .box_id(&box_id)
//!     .box_dir(&box_dir)
//!     .security(security)
//!     .build()?;
//!
//! jailer.setup_pre_spawn()?;  // Create cgroup (Linux)
//! let cmd = jailer.build_command(&binary, &args);  // Includes pre_exec hook
//! cmd.spawn()?;
//! ```

// ============================================================================
// Module declarations
// ============================================================================

// Core modules
mod builder;
mod command;
mod common;
mod error;
mod pre_exec;

// Platform-specific modules
pub mod platform;

// Linux-only modules
#[cfg(target_os = "linux")]
pub(crate) mod apparmor;
#[cfg(target_os = "linux")]
pub(crate) mod bwrap;
#[cfg(target_os = "linux")]
pub(crate) mod cgroup;
#[cfg(target_os = "linux")]
pub(crate) mod credentials;
#[cfg(target_os = "linux")]
pub mod seccomp;
#[cfg(target_os = "linux")]
pub(crate) mod shim_copy;

// ============================================================================
// Public re-exports
// ============================================================================

// Core types
pub use crate::runtime::advanced_options::{ResourceLimits, SecurityOptions};
pub use builder::{Jailer, JailerBuilder};
pub use error::{ConfigError, IsolationError, JailerError, SystemError};
pub use platform::{PlatformIsolation, SpawnIsolation};

// Volume specification (convenience re-export)
pub use crate::runtime::options::VolumeSpec;

// Linux-specific exports
#[cfg(target_os = "linux")]
pub use bwrap::{build_shim_command, is_available as is_bwrap_available};
#[cfg(target_os = "linux")]
pub use seccomp::SeccompRole;

// macOS-specific exports
#[cfg(target_os = "macos")]
pub use platform::macos::{
    SANDBOX_EXEC_PATH, get_base_policy, get_network_policy, get_sandbox_exec_args,
    is_sandbox_available,
};
