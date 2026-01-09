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
pub mod platform;

// Cgroup module (Linux only)
#[cfg(target_os = "linux")]
mod cgroup;

// Seccomp module (cross-platform definitions, Linux-only implementation)
pub mod seccomp;

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

#[cfg(target_os = "linux")]
use boxlite_shared::errors::BoxliteError;
use boxlite_shared::errors::BoxliteResult;

// ============================================================================
// Shim Copy Utilities (Firecracker pattern)
// ============================================================================

use std::path::{Path, PathBuf};
use std::process::Command;

/// Copy shim binary and bundled libraries to box directory for jail isolation.
///
/// This follows Firecracker's approach: copy (not hard-link) binaries into the
/// jail directory to ensure complete memory isolation between boxes.
///
/// Returns the path to the copied shim binary.
#[cfg(target_os = "linux")]
fn copy_shim_to_box(shim_path: &Path, box_dir: &Path) -> BoxliteResult<PathBuf> {
    let bin_dir = box_dir.join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create bin directory {}: {}",
            bin_dir.display(),
            e
        ))
    })?;

    // Copy shim binary
    let shim_name = shim_path.file_name().unwrap_or_default();
    let dest_shim = bin_dir.join(shim_name);

    // Only copy if not already present or source is newer
    let should_copy = if dest_shim.exists() {
        let src_meta = std::fs::metadata(shim_path).ok();
        let dst_meta = std::fs::metadata(&dest_shim).ok();
        match (src_meta, dst_meta) {
            (Some(src), Some(dst)) => {
                src.modified().ok() > dst.modified().ok() || src.len() != dst.len()
            }
            _ => true,
        }
    } else {
        true
    };

    if should_copy {
        std::fs::copy(shim_path, &dest_shim).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to copy shim {} to {}: {}",
                shim_path.display(),
                dest_shim.display(),
                e
            ))
        })?;
        tracing::debug!(
            src = %shim_path.display(),
            dst = %dest_shim.display(),
            "Copied shim binary to box directory"
        );
    }

    // Copy bundled libraries from shim's directory
    if let Some(shim_dir) = shim_path.parent() {
        copy_bundled_libraries(shim_dir, &bin_dir)?;
    }

    Ok(dest_shim)
}

/// Copy bundled libraries (libkrun, libkrunfw, libgvproxy) to destination.
#[cfg(target_os = "linux")]
fn copy_bundled_libraries(src_dir: &Path, dest_dir: &Path) -> BoxliteResult<()> {
    let lib_patterns = ["libkrun.so", "libkrunfw.so", "libgvproxy.so"];

    if let Ok(entries) = std::fs::read_dir(src_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            // Check if this file matches any of our library patterns
            if lib_patterns.iter().any(|p| name_str.starts_with(p)) {
                let src_path = entry.path();
                let dest_path = dest_dir.join(&name);

                // Only copy if not already present or source is newer
                let should_copy = if dest_path.exists() {
                    let src_meta = std::fs::metadata(&src_path).ok();
                    let dst_meta = std::fs::metadata(&dest_path).ok();
                    match (src_meta, dst_meta) {
                        (Some(src), Some(dst)) => {
                            src.modified().ok() > dst.modified().ok() || src.len() != dst.len()
                        }
                        _ => true,
                    }
                } else {
                    true
                };

                if should_copy {
                    std::fs::copy(&src_path, &dest_path).map_err(|e| {
                        BoxliteError::Storage(format!(
                            "Failed to copy library {} to {}: {}",
                            src_path.display(),
                            dest_path.display(),
                            e
                        ))
                    })?;
                    tracing::debug!(
                        lib = %name_str,
                        dst = %dest_path.display(),
                        "Copied bundled library to box directory"
                    );
                }
            }
        }
    }

    Ok(())
}

// ============================================================================
// Jailer Struct
// ============================================================================

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
/// Volume specification (re-exported for convenience).
pub use crate::runtime::options::VolumeSpec;

#[derive(Debug, Clone)]
pub struct Jailer {
    /// Security configuration options
    security: SecurityOptions,
    /// Volume mounts (for sandbox path restrictions)
    volumes: Vec<VolumeSpec>,
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
            volumes: Vec::new(),
            box_id: box_id.into(),
            box_dir: box_dir.into(),
        }
    }

    /// Set security options (builder pattern).
    pub fn with_security(mut self, security: SecurityOptions) -> Self {
        self.security = security;
        self
    }

    /// Set volume mounts (builder pattern).
    ///
    /// Volumes are used for sandbox path restrictions (macOS).
    /// All volumes are added to readable paths; writable volumes are also added to writable paths.
    pub fn with_volumes(mut self, volumes: Vec<VolumeSpec>) -> Self {
        self.volumes = volumes;
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
        // =====================================================================
        // Firecracker pattern: Copy shim binary and libraries to box directory
        // =====================================================================
        // This ensures:
        // 1. No external bind mounts needed (works with root user)
        // 2. Complete memory isolation between boxes (no shared .text section)
        // 3. Each box has its own copy of the shim and libraries

        let (shim_binary, bin_dir) = match copy_shim_to_box(binary, &self.box_dir) {
            Ok(copied_shim) => {
                let bin_dir = copied_shim.parent().unwrap_or(&self.box_dir).to_path_buf();
                tracing::info!(
                    original = %binary.display(),
                    copied = %copied_shim.display(),
                    "Using copied shim binary (Firecracker pattern)"
                );
                (copied_shim, bin_dir)
            }
            Err(e) => {
                // Fallback to original binary if copy fails
                tracing::warn!(
                    error = %e,
                    "Failed to copy shim to box directory, using original"
                );
                let bin_dir = binary.parent().unwrap_or(binary).to_path_buf();
                (binary.to_path_buf(), bin_dir)
            }
        };

        let mut bwrap = bwrap::BwrapCommand::new()
            .with_default_namespaces()
            .with_die_with_parent()
            .with_new_session()
            // TODO(security): Eliminate /usr, /lib, /bin, /sbin bind mounts by statically
            // linking boxlite-shim with musl. This requires:
            // 1. Build libkrun with musl (CC=musl-gcc)
            // 2. Build libgvproxy with musl (CGO_ENABLED=1 CC=musl-gcc)
            // 3. Build boxlite-shim with --target x86_64-unknown-linux-musl
            // 4. Remove these ro_bind_if_exists calls below
            // System directories (read-only) - needed until static linking is implemented
            .ro_bind_if_exists("/usr", "/usr")
            .ro_bind_if_exists("/lib", "/lib")
            .ro_bind_if_exists("/lib64", "/lib64")
            .ro_bind_if_exists("/bin", "/bin")
            .ro_bind_if_exists("/sbin", "/sbin")
            // Devices
            .with_dev()
            .dev_bind_if_exists("/dev/kvm", "/dev/kvm")
            .dev_bind_if_exists("/dev/net/tun", "/dev/net/tun")
            .with_proc()
            .tmpfs("/tmp");

        // Mount minimal directories for security isolation
        // Only this box's directory and required runtime directories are accessible

        // 1. Mount this box's directory (read-write)
        //    Contains: bin/, sockets/, shared/, disk.qcow2, guest-rootfs.qcow2
        //    The shim binary and libraries are now INSIDE this directory
        bwrap = bwrap.bind(&self.box_dir, &self.box_dir);
        tracing::debug!(box_dir = %self.box_dir.display(), "bwrap: mounted box directory");

        // Get boxlite home directory for other mounts
        if let Some(boxes_dir) = self.box_dir.parent()
            && let Some(home_dir) = boxes_dir.parent()
        {
            // 2. Mount logs directory (read-write for shim logging + console output)
            let logs_dir = home_dir.join("logs");
            if logs_dir.exists() {
                bwrap = bwrap.bind(&logs_dir, &logs_dir);
                tracing::debug!(logs_dir = %logs_dir.display(), "bwrap: mounted logs directory");
            }

            // 3. Mount tmp directory (read-write for rootfs preparation)
            //    Contains: temporary rootfs mounts during box creation
            let tmp_dir = home_dir.join("tmp");
            if tmp_dir.exists() {
                bwrap = bwrap.bind(&tmp_dir, &tmp_dir);
                tracing::debug!(tmp_dir = %tmp_dir.display(), "bwrap: mounted tmp directory");
            }

            // 4. Mount images directory (read-only for extracted OCI layers)
            //    Contains: extracted layer data used for rootfs
            let images_dir = home_dir.join("images");
            if images_dir.exists() {
                bwrap = bwrap.ro_bind(&images_dir, &images_dir);
                tracing::debug!(images_dir = %images_dir.display(), "bwrap: mounted images directory (ro)");
            }
        }

        // NOTE: No external shim directory bind mount needed!
        // The shim and libraries are now copied into box_dir/bin/

        // Environment sanitization
        bwrap = bwrap
            .with_clearenv()
            .setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .setenv("HOME", "/root");

        // Set LD_LIBRARY_PATH to the copied libraries directory
        // This is inside box_dir, so no external bind mount needed
        bwrap = bwrap.setenv("LD_LIBRARY_PATH", bin_dir.to_string_lossy().to_string());
        tracing::debug!(ld_library_path = %bin_dir.display(), "Set LD_LIBRARY_PATH to copied libs directory");

        // Preserve RUST_LOG for debugging
        if let Ok(rust_log) = std::env::var("RUST_LOG") {
            bwrap = bwrap.setenv("RUST_LOG", rust_log);
        }

        bwrap.chdir("/").build(&shim_binary, args)
    }

    #[cfg(target_os = "macos")]
    fn build_command_macos(&self, binary: &Path, args: &[String]) -> Command {
        let mut cmd = if platform::macos::is_sandbox_available() {
            tracing::info!("Building sandbox-exec isolated command");
            let (sandbox_cmd, sandbox_args) = platform::macos::get_sandbox_exec_args(
                &self.security,
                &self.box_dir,
                binary,
                &self.volumes,
            );
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
