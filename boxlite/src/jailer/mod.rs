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
//! ├── mod.rs          (public API)
//! ├── config/         (SecurityOptions, ResourceLimits)
//! ├── error.rs        (hierarchical error types)
//! ├── common/         (cross-platform: env, fd, rlimit)
//! └── platform/       (PlatformIsolation trait)
//!     ├── linux/      (namespaces, seccomp, chroot)
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
//! // In spawn.rs (parent process)
//! let jailer = Jailer::new(&box_id, &box_dir)
//!     .with_security(security);
//!
//! jailer.setup_pre_spawn()?;  // Create cgroup (Linux)
//! let cmd = jailer.build_command(&binary, &args);  // Includes pre_exec hook
//! cmd.spawn()?;
//! ```

mod common;
mod config;
mod error;
mod platform;

// Cgroup module (Linux only)
#[cfg(target_os = "linux")]
mod cgroup;

// Re-export bwrap utilities (Linux spawn integration)
mod bwrap;
#[cfg(target_os = "linux")]
pub use bwrap::{build_shim_command, is_available as is_bwrap_available};

// Re-export macOS sandbox utilities (spawn integration)
#[cfg(target_os = "macos")]
pub use platform::macos::{
    SANDBOX_EXEC_PATH, get_base_policy, get_network_policy, get_sandbox_exec_args,
    is_sandbox_available,
};

// Public types
pub use config::{ResourceLimits, SecurityOptions};
pub use error::{ConfigError, IsolationError, JailerError, SystemError};
pub use platform::{PlatformIsolation, SpawnIsolation};

use boxlite_shared::errors::BoxliteResult;

// ============================================================================
// Jailer Struct
// ============================================================================

use std::path::{Path, PathBuf};
use std::process::Command;

/// Jailer provides process isolation for boxlite-shim.
///
/// Encapsulates security configuration and provides methods for spawn-time
/// isolation. All isolation (FD cleanup, rlimits, cgroups) is applied via
/// `pre_exec` hook before exec, eliminating the attack window.
///
/// # Example
///
/// ```ignore
/// use boxlite::jailer::Jailer;
///
/// // In spawn.rs (parent process)
/// let jailer = Jailer::new(&box_id, &box_dir)
///     .with_security(security);
///
/// jailer.setup_pre_spawn()?;  // Create cgroup (Linux)
/// let cmd = jailer.build_command(&binary, &args);  // Includes pre_exec hook
/// cmd.spawn()?;
/// ```
#[derive(Debug, Clone)]
pub struct Jailer {
    /// Security configuration options
    security: SecurityOptions,
    /// Unique box identifier
    box_id: String,
    /// Box directory path
    box_dir: PathBuf,
}

impl Jailer {
    // ─────────────────────────────────────────────────────────────────────
    // Constructors
    // ─────────────────────────────────────────────────────────────────────

    /// Create a new Jailer with default security options.
    pub fn new(box_id: impl Into<String>, box_dir: impl Into<PathBuf>) -> Self {
        Self {
            security: SecurityOptions::default(),
            box_id: box_id.into(),
            box_dir: box_dir.into(),
        }
    }

    /// Set security options (builder pattern).
    pub fn with_security(mut self, security: SecurityOptions) -> Self {
        self.security = security;
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Getters
    // ─────────────────────────────────────────────────────────────────────

    /// Get the security options.
    pub fn security(&self) -> &SecurityOptions {
        &self.security
    }

    /// Get mutable reference to security options.
    pub fn security_mut(&mut self) -> &mut SecurityOptions {
        &mut self.security
    }

    /// Get the box ID.
    pub fn box_id(&self) -> &str {
        &self.box_id
    }

    /// Get the box directory.
    pub fn box_dir(&self) -> &Path {
        &self.box_dir
    }

    // ─────────────────────────────────────────────────────────────────────
    // Primary API (spawn-time)
    // ─────────────────────────────────────────────────────────────────────

    /// Setup pre-spawn isolation (cgroups on Linux, no-op on macOS).
    ///
    /// Call this before `build_command()` to set up isolation that
    /// must be configured from the parent process.
    ///
    /// On Linux, this creates the cgroup directory and configures resource limits.
    /// The child process will add itself to the cgroup in the pre_exec hook.
    pub fn setup_pre_spawn(&self) -> BoxliteResult<()> {
        #[cfg(target_os = "linux")]
        {
            use crate::jailer::cgroup::{CgroupConfig, setup_cgroup};

            let cgroup_config = CgroupConfig::from(&self.security.resource_limits);

            match setup_cgroup(&self.box_id, &cgroup_config) {
                Ok(path) => {
                    tracing::info!(
                        box_id = %self.box_id,
                        path = %path.display(),
                        "Cgroup created for box"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        box_id = %self.box_id,
                        error = %e,
                        "Cgroup setup failed (continuing without cgroup limits)"
                    );
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            tracing::debug!(
                box_id = %self.box_id,
                "Pre-spawn isolation: no-op on macOS (no cgroups)"
            );
        }

        Ok(())
    }

    /// Build an isolated command that wraps the given binary.
    ///
    /// On Linux: wraps with bwrap for namespace isolation
    /// On macOS: wraps with sandbox-exec for Seatbelt sandbox
    ///
    /// The command includes a `pre_exec` hook that closes inherited file
    /// descriptors before any code runs, eliminating the attack window.
    pub fn build_command(&self, binary: &Path, args: &[String]) -> Command {
        #[cfg(target_os = "linux")]
        {
            self.build_command_linux(binary, args)
        }
        #[cfg(target_os = "macos")]
        {
            self.build_command_macos(binary, args)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            self.build_command_direct(binary, args)
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Private platform implementations
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "linux")]
    fn build_command_linux(&self, binary: &Path, args: &[String]) -> Command {
        let mut cmd = if bwrap::is_available() {
            tracing::info!("Building bwrap-isolated command");
            self.build_bwrap_command(binary, args)
        } else {
            tracing::warn!("bwrap not available, using direct command");
            let mut cmd = Command::new(binary);
            cmd.args(args);
            cmd
        };

        let resource_limits = self.security.resource_limits.clone();
        let cgroup_procs_path = cgroup::build_cgroup_procs_path(&self.box_id);

        Self::add_pre_exec_hook(&mut cmd, resource_limits, cgroup_procs_path);
        cmd
    }

    #[cfg(target_os = "linux")]
    fn build_bwrap_command(&self, binary: &Path, args: &[String]) -> Command {
        bwrap::BwrapCommand::new()
            .with_default_namespaces()
            .with_die_with_parent()
            .with_new_session()
            .ro_bind_if_exists("/usr", "/usr")
            .ro_bind_if_exists("/lib", "/lib")
            .ro_bind_if_exists("/lib64", "/lib64")
            .ro_bind_if_exists("/bin", "/bin")
            .ro_bind_if_exists("/sbin", "/sbin")
            .with_dev()
            .dev_bind_if_exists("/dev/kvm", "/dev/kvm")
            .dev_bind_if_exists("/dev/net/tun", "/dev/net/tun")
            .with_proc()
            .tmpfs("/tmp")
            .bind(&self.box_dir, &self.box_dir)
            .with_clearenv()
            .setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .setenv("HOME", "/root")
            .chdir("/")
            .build(binary, args)
    }

    #[cfg(target_os = "macos")]
    fn build_command_macos(&self, binary: &Path, args: &[String]) -> Command {
        let mut cmd = if platform::macos::is_sandbox_available() {
            tracing::info!("Building sandbox-exec isolated command");
            let (sandbox_cmd, sandbox_args) =
                platform::macos::get_sandbox_exec_args(&self.security, &self.box_dir, binary);
            let mut cmd = Command::new(sandbox_cmd);
            cmd.args(sandbox_args);
            cmd.arg(binary);
            cmd.args(args);
            cmd
        } else {
            tracing::warn!("sandbox-exec not available, using direct command");
            let mut cmd = Command::new(binary);
            cmd.args(args);
            cmd
        };

        let resource_limits = self.security.resource_limits.clone();
        Self::add_pre_exec_hook(&mut cmd, resource_limits, None);
        cmd
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn build_command_direct(&self, binary: &Path, args: &[String]) -> Command {
        tracing::warn!("No sandbox available on this platform");
        let mut cmd = Command::new(binary);
        cmd.args(args);

        let resource_limits = self.security.resource_limits.clone();
        Self::add_pre_exec_hook(&mut cmd, resource_limits, None);
        cmd
    }

    // ─────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────

    /// Add pre_exec hook for process isolation (async-signal-safe).
    ///
    /// Runs after fork() but before exec() in the child process.
    /// Applies: FD cleanup, rlimits, cgroup membership (Linux).
    fn add_pre_exec_hook(
        cmd: &mut Command,
        resource_limits: ResourceLimits,
        #[allow(unused_variables)] cgroup_procs_path: Option<std::ffi::CString>,
    ) {
        use std::os::unix::process::CommandExt;

        unsafe {
            cmd.pre_exec(move || {
                // 1. Close inherited file descriptors
                common::fd::close_inherited_fds_raw().map_err(std::io::Error::from_raw_os_error)?;

                // 2. Apply resource limits (rlimits)
                common::rlimit::apply_limits_raw(&resource_limits)
                    .map_err(std::io::Error::from_raw_os_error)?;

                // 3. Add self to cgroup (Linux only)
                #[cfg(target_os = "linux")]
                if let Some(ref path) = cgroup_procs_path {
                    let _ = cgroup::add_self_to_cgroup_raw(path);
                }

                Ok(())
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Associated functions (static)
    // ─────────────────────────────────────────────────────────────────────

    /// Check if jailer isolation is supported on this platform.
    pub fn is_supported() -> bool {
        platform::current().is_available()
    }

    /// Get the current platform name.
    pub fn platform_name() -> &'static str {
        platform::current().name()
    }
}
