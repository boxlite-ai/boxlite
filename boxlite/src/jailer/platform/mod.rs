//! Platform-specific isolation implementations.
//!
//! This module provides a trait-based abstraction over platform-specific
//! isolation mechanisms, allowing clean polymorphism without scattered `#[cfg]`.
//!
//! # Architecture
//!
//! ```text
//! PlatformIsolation (trait)
//!     ├── LinuxPlatform    → namespaces, seccomp, chroot
//!     └── MacOSPlatform    → sandbox-exec (Seatbelt)
//! ```

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "macos")]
pub mod macos;

use crate::runtime::advanced_options::SecurityOptions;
use crate::runtime::options::VolumeSpec;
use boxlite_shared::errors::BoxliteResult;
use std::path::Path;

/// Platform-agnostic isolation interface.
///
/// Different platforms implement fundamentally different isolation mechanisms:
/// - **Linux**: namespaces, seccomp, chroot, privilege dropping
/// - **macOS**: Seatbelt sandbox via `sandbox-exec`
///
/// This trait provides a common interface for both.
pub trait PlatformIsolation: Send + Sync {
    /// Apply isolation to the current process.
    ///
    /// Called inside the shim after fork but before exec.
    fn apply_isolation(&self, security: &SecurityOptions, box_id: &str) -> BoxliteResult<()>;

    /// Get spawn-time sandbox arguments.
    ///
    /// On macOS, isolation is applied at spawn time via `sandbox-exec`.
    /// Returns `None` on platforms where isolation is applied post-fork.
    fn get_spawn_args(
        &self,
        security: &SecurityOptions,
        box_dir: &Path,
        binary_path: &Path,
        volumes: &[VolumeSpec],
    ) -> Option<SpawnIsolation>;

    /// Platform name for logging/debugging.
    fn name(&self) -> &'static str;

    /// Check if this platform's isolation is available.
    fn is_available(&self) -> bool;
}

/// Spawn-time isolation arguments.
///
/// Used on macOS where sandbox is applied by wrapping the command
/// with `sandbox-exec -p <policy>`.
#[derive(Debug, Clone)]
pub struct SpawnIsolation {
    /// Wrapper binary (e.g., `/usr/bin/sandbox-exec`).
    pub wrapper: String,
    /// Arguments to wrapper before the actual command.
    pub args: Vec<String>,
}

// ============================================================================
// Platform Implementations
// ============================================================================

/// Linux isolation using namespaces, seccomp, chroot.
#[cfg(target_os = "linux")]
pub struct LinuxPlatform;

#[cfg(target_os = "linux")]
impl PlatformIsolation for LinuxPlatform {
    fn apply_isolation(&self, security: &SecurityOptions, box_id: &str) -> BoxliteResult<()> {
        if security.seccomp_enabled {
            linux::apply_vmm_filter(box_id)?;
        } else {
            tracing::warn!(
                box_id = %box_id,
                "Seccomp disabled - running without syscall filtering"
            );
        }
        Ok(())
    }

    fn get_spawn_args(
        &self,
        _security: &SecurityOptions,
        _box_dir: &Path,
        _binary_path: &Path,
        _volumes: &[VolumeSpec],
    ) -> Option<SpawnIsolation> {
        // Linux doesn't use spawn-time wrapping
        // (bwrap is handled separately in spawn.rs)
        None
    }

    fn name(&self) -> &'static str {
        "Linux"
    }

    fn is_available(&self) -> bool {
        linux::is_available()
    }
}

/// macOS isolation using Seatbelt sandbox.
#[cfg(target_os = "macos")]
pub struct MacOSPlatform;

#[cfg(target_os = "macos")]
impl PlatformIsolation for MacOSPlatform {
    fn apply_isolation(&self, security: &SecurityOptions, box_id: &str) -> BoxliteResult<()> {
        macos::apply_isolation(security, box_id)
    }

    fn get_spawn_args(
        &self,
        security: &SecurityOptions,
        box_dir: &Path,
        binary_path: &Path,
        volumes: &[VolumeSpec],
    ) -> Option<SpawnIsolation> {
        let (wrapper, args) = macos::get_sandbox_exec_args(security, box_dir, binary_path, volumes);
        Some(SpawnIsolation { wrapper, args })
    }

    fn name(&self) -> &'static str {
        "macOS"
    }

    fn is_available(&self) -> bool {
        macos::is_sandbox_available()
    }
}

// ============================================================================
// Current Platform
// ============================================================================

/// Get the current platform's isolation implementation.
///
/// Returns a static reference to avoid allocation.
#[cfg(target_os = "linux")]
pub fn current() -> &'static dyn PlatformIsolation {
    static PLATFORM: LinuxPlatform = LinuxPlatform;
    &PLATFORM
}

#[cfg(target_os = "macos")]
pub fn current() -> &'static dyn PlatformIsolation {
    static PLATFORM: MacOSPlatform = MacOSPlatform;
    &PLATFORM
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn current() -> &'static dyn PlatformIsolation {
    static PLATFORM: UnsupportedPlatform = UnsupportedPlatform;
    &PLATFORM
}

/// Fallback for unsupported platforms.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
struct UnsupportedPlatform;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
impl PlatformIsolation for UnsupportedPlatform {
    fn apply_isolation(&self, _security: &SecurityOptions, _box_id: &str) -> BoxliteResult<()> {
        Err(crate::jailer::JailerError::UnsupportedPlatform.into())
    }

    fn get_spawn_args(
        &self,
        _security: &SecurityOptions,
        _box_dir: &Path,
        _binary_path: &Path,
        _volumes: &[VolumeSpec],
    ) -> Option<SpawnIsolation> {
        None
    }

    fn name(&self) -> &'static str {
        "Unsupported"
    }

    fn is_available(&self) -> bool {
        false
    }
}
