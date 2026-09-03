//! Sandbox abstraction for platform-specific process isolation.
//!
//! This module provides the [`Sandbox`] trait — the internal mechanism that
//! applies isolation to a command at spawn time.
//!
//! Callers don't use `Sandbox` directly; they use the [`Jail`](super::Jail)
//! trait. Only [`Jailer`](super::Jailer) knows about sandboxes.
//!
//! # Implementations
//!
//! | Sandbox | Platform | Mechanism |
//! |---------|----------|-----------|
//! | [`BwrapSandbox`] | Linux | bubblewrap namespaces + cgroups |
//! | [`LandlockSandbox`] | Linux | Landlock filesystem/network ACL |
//! | [`SeatbeltSandbox`] | macOS | sandbox-exec SBPL |
//! | [`CompositeSandbox`] | any | chains multiple sandboxes |
//! | [`NoopSandbox`] | any | passthrough (no isolation) |
//!
//! # Composition
//!
//! Sandboxes compose naturally via [`CompositeSandbox`]:
//! ```ignore
//! let sandbox = CompositeSandbox::new(vec![
//!     Box::new(BwrapSandbox::new()),
//!     Box::new(LandlockSandbox::new()),
//! ]);
//! ```
//! Each child's `apply()` is called in order on the same `Command`.

#[cfg(target_os = "linux")]
mod bwrap;
mod composite;
#[cfg(target_os = "linux")]
mod landlock;
#[cfg(target_os = "macos")]
pub mod seatbelt;

#[cfg(target_os = "linux")]
pub use bwrap::BwrapSandbox;
pub use composite::CompositeSandbox;
#[cfg(target_os = "linux")]
pub use landlock::LandlockSandbox;
#[cfg(target_os = "macos")]
pub use seatbelt::SeatbeltSandbox;

use crate::runtime::advanced_options::ResourceLimits;
use crate::runtime::options::DiskIoLimits;
use boxlite_shared::errors::BoxliteResult;
use std::path::{Path, PathBuf};
use std::process::Command;

// ============================================================================
// Sandbox Trait
// ============================================================================

/// Platform-specific process isolation.
///
/// Each sandbox modifies a `Command` via [`apply()`](Sandbox::apply):
/// - **Namespace sandboxes** (bwrap) replace the command with a wrapper
/// - **Restriction sandboxes** (Landlock) add `pre_exec` hooks
/// - **Composed sandboxes** chain multiple `apply()` calls
///
/// Multiple `pre_exec` hooks are safe — `Command` stores them in a `Vec`,
/// executed in registration order.
pub trait Sandbox: Send + Sync {
    /// Whether the sandbox tool is installed and usable.
    fn is_available(&self) -> bool;

    /// Pre-spawn setup (cgroups, userns preflight).
    ///
    /// Called from the parent process before spawning. Default: no-op.
    fn setup(&self, _ctx: &SandboxContext) -> BoxliteResult<()> {
        Ok(())
    }

    /// Apply sandbox isolation to the command.
    ///
    /// Modifies the command in-place. The command already has binary and args
    /// set — use `cmd.get_program()` / `cmd.get_args()` to extract them
    /// if needed (e.g., to wrap with bwrap).
    fn apply(&self, ctx: &SandboxContext, cmd: &mut Command);

    /// Name for logging.
    fn name(&self) -> &'static str;
}

// ============================================================================
// PathAccess
// ============================================================================

/// A filesystem path with access permissions for the sandbox.
///
/// Pre-computed by callers and the [`Jailer`](super::Jailer) from the paths
/// required by the confined process. Sandbox implementations translate these
/// to platform-specific mechanisms:
/// - bwrap: `--bind` (writable) or `--ro-bind` (read-only)
/// - seatbelt: `file-read*` + `file-write*` subpath rules
#[derive(Debug, Clone)]
pub struct PathAccess {
    /// Host filesystem path.
    pub path: PathBuf,
    /// Whether write access is required.
    pub writable: bool,
}

/// Exact Unix-domain socket endpoints needed by the confined process.
///
/// Seatbelt distinguishes creating a listener from connecting to one, so the
/// jailer keeps the two capabilities separate instead of granting both to an
/// entire writable directory.
#[derive(Debug, Clone, Default)]
pub struct UnixSocketAccess {
    /// Socket paths the confined process may bind.
    pub bind: Vec<PathBuf>,
    /// Socket paths the confined process may connect or send to.
    pub connect: Vec<PathBuf>,
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
    /// Pre-computed exact AF_UNIX socket access rules.
    pub unix_sockets: UnixSocketAccess,
    /// Resource limits (for cgroup configuration).
    pub resource_limits: &'a ResourceLimits,
    /// Whether network access is enabled.
    pub network_enabled: bool,
    /// Custom sandbox profile path (macOS only).
    pub sandbox_profile: Option<&'a Path>,
    /// Whether the box is detached (`run -d`). Detached boxes must outlive the
    /// launching process, so the sandbox must not tie their lifetime to it
    /// (e.g. bwrap's `--die-with-parent`).
    pub detached: bool,
    /// Disk I/O rate limits requested for the box, if any.
    pub disk_io: Option<&'a DiskIoLimits>,
    /// The disk image files the VMM reads and writes (COW layers and their
    /// backing chain). Their host block devices are what `disk_io` throttles.
    pub disk_images: Vec<PathBuf>,
}

/// Log that requested disk I/O limits will not be enforced, and why.
///
/// Disk limits degrade like the rest of the cgroup limits (warn and continue,
/// see `BwrapSandbox::setup`) rather than failing the spawn, so every sandbox
/// that cannot enforce them says so in one recognizable place.
pub(super) fn warn_disk_io_not_enforced(ctx: &SandboxContext, reason: &str) {
    if ctx.disk_io.is_some() {
        tracing::warn!(id = %ctx.id, "Disk io limits requested but not enforced: {reason}");
    }
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
/// On Linux: [`CompositeSandbox`] combining bwrap (namespaces) + Landlock (filesystem ACL).
/// On macOS: [`SeatbeltSandbox`] (sandbox-exec).
/// On other: [`NoopSandbox`] (passthrough).
#[cfg(target_os = "linux")]
pub type PlatformSandbox = CompositeSandbox;

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

    /// Platform constructor alias (used by [`JailerBuilder`](super::JailerBuilder)).
    pub fn platform_new() -> Self {
        Self::new()
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

    fn setup(&self, ctx: &SandboxContext) -> BoxliteResult<()> {
        warn_disk_io_not_enforced(ctx, "no sandbox on this platform (no cgroups)");
        Ok(())
    }

    fn apply(&self, _ctx: &SandboxContext, _cmd: &mut Command) {}

    fn name(&self) -> &'static str {
        "noop"
    }
}
