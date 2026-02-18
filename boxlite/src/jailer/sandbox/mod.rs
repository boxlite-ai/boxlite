//! Sandbox abstraction for platform-specific process wrapping.
//!
//! This module provides the [`Sandbox`] trait — the internal mechanism that
//! wraps a command with platform-specific isolation at spawn time.
//!
//! Callers don't use `Sandbox` directly; they use the [`Jail`](super::Jail)
//! trait. Only [`Jailer`](super::Jailer) knows about sandboxes.
//!
//! # Implementations
//!
//! | Sandbox | Platform | Mechanism |
//! |---------|----------|-----------|
//! | [`BwrapSandbox`] | Linux | bubblewrap namespaces |
//! | [`SeatbeltSandbox`] | macOS | sandbox-exec SBPL |
//! | [`NoopSandbox`] | any | passthrough (no isolation) |

#[cfg(target_os = "linux")]
mod bwrap;
#[cfg(target_os = "macos")]
pub mod seatbelt;

#[cfg(target_os = "linux")]
pub use bwrap::BwrapSandbox;
#[cfg(target_os = "macos")]
pub use seatbelt::SeatbeltSandbox;

use crate::runtime::advanced_options::ResourceLimits;
use boxlite_shared::errors::BoxliteResult;
use std::path::{Path, PathBuf};
use std::process::Command;

// ============================================================================
// Sandbox Trait
// ============================================================================

/// Platform-specific sandbox wrapping.
///
/// Wraps a command with isolation at spawn time.
/// Used internally by [`Jailer`](super::Jailer); callers use the
/// [`Jail`](super::Jail) trait.
///
/// Each implementation is a zero-sized unit struct — no runtime cost,
/// monomorphized at compile time.
pub trait Sandbox: Send + Sync {
    /// Whether the sandbox tool is installed and usable.
    fn is_available(&self) -> bool;

    /// Platform-specific pre-spawn setup (cgroups, userns preflight).
    ///
    /// Called from the parent process before spawning.
    fn setup(&self, ctx: &SandboxContext) -> BoxliteResult<()>;

    /// Wrap the binary with sandbox isolation.
    ///
    /// Returns a `Command` with the binary wrapped by the sandbox tool.
    /// Assumes `is_available()` is true. Caller checks first.
    fn wrap(&self, ctx: &SandboxContext, binary: &Path, args: &[String]) -> Command;

    /// Cgroup procs path for the pre_exec hook.
    ///
    /// Returns `Some` on Linux (for cgroup join), `None` elsewhere.
    fn cgroup_procs_path(&self, ctx: &SandboxContext) -> Option<std::ffi::CString>;

    /// Name for logging.
    fn name(&self) -> &'static str;
}

// ============================================================================
// PathAccess
// ============================================================================

/// A filesystem path with access permissions for the sandbox.
///
/// Pre-computed by the [`Jailer`](super::Jailer) from system directories
/// and user volumes. Sandbox implementations translate these to
/// platform-specific mechanisms:
/// - bwrap: `--bind` (writable) or `--ro-bind` (read-only)
/// - seatbelt: `file-read*` + `file-write*` subpath rules
#[derive(Debug, Clone)]
pub struct PathAccess {
    /// Host filesystem path.
    pub path: PathBuf,
    /// Whether write access is required.
    pub writable: bool,
}

// ============================================================================
// SandboxContext
// ============================================================================

/// What the sandbox needs to do its job.
///
/// Translated from [`SecurityOptions`](crate::runtime::advanced_options::SecurityOptions)
/// by the [`Jailer`](super::Jailer). The sandbox never sees `SecurityOptions`
/// or box-specific paths — only pre-computed access rules.
///
/// This is the abstraction boundary: the sandbox gets only the fields it needs,
/// not the entire config struct.
pub struct SandboxContext<'a> {
    /// Identifier for resource naming (cgroups, logging).
    pub id: &'a str,
    /// Pre-computed filesystem path access rules.
    pub paths: Vec<PathAccess>,
    /// Resource limits (for cgroup configuration).
    pub resource_limits: &'a ResourceLimits,
    /// Whether network access is enabled.
    pub network_enabled: bool,
    /// Custom sandbox profile path (macOS only).
    pub sandbox_profile: Option<&'a Path>,
}

impl SandboxContext<'_> {
    /// Paths that require write access.
    pub fn writable_paths(&self) -> impl Iterator<Item = &PathAccess> {
        self.paths.iter().filter(|p| p.writable)
    }

    /// Paths that are read-only.
    pub fn readonly_paths(&self) -> impl Iterator<Item = &PathAccess> {
        self.paths.iter().filter(|p| !p.writable)
    }
}

// ============================================================================
// PlatformSandbox type alias — single #[cfg] dispatch point
// ============================================================================

/// The sandbox for the current platform.
///
/// This is the single point where platform dispatch happens.
/// All other code is generic over `S: Sandbox`.
#[cfg(target_os = "linux")]
pub type PlatformSandbox = BwrapSandbox;

#[cfg(target_os = "macos")]
pub type PlatformSandbox = SeatbeltSandbox;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub type PlatformSandbox = NoopSandbox;

// ============================================================================
// NoopSandbox — unsupported platforms or jailer disabled
// ============================================================================

/// Passthrough sandbox that applies no isolation.
///
/// Used on unsupported platforms. The command runs directly.
#[derive(Debug)]
pub struct NoopSandbox;

impl NoopSandbox {
    pub fn new() -> Self {
        Self
    }
}

impl Default for NoopSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Sandbox for NoopSandbox {
    fn is_available(&self) -> bool {
        false
    }

    fn setup(&self, _ctx: &SandboxContext) -> BoxliteResult<()> {
        Ok(())
    }

    fn wrap(&self, _ctx: &SandboxContext, binary: &Path, args: &[String]) -> Command {
        let mut cmd = Command::new(binary);
        cmd.args(args);
        cmd
    }

    fn cgroup_procs_path(&self, _ctx: &SandboxContext) -> Option<std::ffi::CString> {
        None
    }

    fn name(&self) -> &'static str {
        "noop"
    }
}
