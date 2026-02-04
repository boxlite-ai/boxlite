//! Bubblewrap (bwrap) command builder for Linux isolation.
//!
//! This module builds the `bwrap` command with appropriate arguments
//! for sandboxing the boxlite-shim process.
//!
//! ## Bwrap Discovery
//!
//! BoxLite looks for bwrap in this order:
//! 1. **System bwrap** - Allows users to use their own version (in PATH)
//! 2. **Bundled bwrap** - Falls back to the version built from bubblewrap-sys
//!
//! ## What Bubblewrap Provides
//!
//! - Namespace isolation (mount, pid, user, ipc, uts)
//! - pivot_root / chroot filesystem isolation
//! - Environment sanitization (--clearenv)
//! - Seccomp filter application (we provide the BPF)
//! - PR_SET_NO_NEW_PRIVS
//! - Die-with-parent behavior
//!
//! ## What We Add Outside Bubblewrap
//!
//! - Cgroups v2 setup (before spawn)
//! - Seccomp BPF filter generation (before spawn)
//! - FD cleanup (inside shim, bwrap leaks some FDs)
//! - rlimits (inside shim)

// Allow dead_code on non-Linux platforms where bwrap is not available
#![allow(dead_code)]

use super::config::SecurityOptions;
use crate::runtime::layout::FilesystemLayout;
use crate::util::find_binary;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Cached path to the bwrap binary (system or bundled).
///
/// This is initialized once on first access and cached for the process lifetime.
static BWRAP_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Get the path to the bwrap binary.
///
/// Search order:
/// 1. System bwrap (in PATH) - allows users to override with their own version
/// 2. Bundled bwrap (from bubblewrap-sys) - fallback for SDK distribution
///
/// Returns `None` if neither is available.
fn get_bwrap_path() -> Option<&'static PathBuf> {
    BWRAP_PATH
        .get_or_init(|| {
            // 1. Try system bwrap first (allows user override)
            if let Ok(output) = Command::new("bwrap").arg("--version").output()
                && output.status.success()
            {
                tracing::debug!("Using system bwrap from PATH");
                return Some(PathBuf::from("bwrap"));
            }

            // 2. Try bundled bwrap (from bubblewrap-sys)
            match find_binary("bwrap") {
                Ok(bundled_path) if bundled_path.exists() => {
                    tracing::debug!(
                        path = %bundled_path.display(),
                        "Using bundled bwrap"
                    );
                    Some(bundled_path)
                }
                Ok(bundled_path) => {
                    tracing::warn!(
                        path = %bundled_path.display(),
                        "Bundled bwrap path found but file does not exist"
                    );
                    None
                }
                Err(e) => {
                    tracing::debug!(
                        error = %e,
                        "Bundled bwrap not found"
                    );
                    None
                }
            }
        })
        .as_ref()
}

/// Check if bubblewrap (bwrap) is available (system or bundled).
pub fn is_available() -> bool {
    get_bwrap_path().is_some()
}

/// Check if bwrap can create user namespaces.
///
/// Runs `bwrap --unshare-user -- true` as a preflight check.
/// This catches AppArmor restrictions and missing kernel support
/// before the actual shim spawn.
///
/// Returns `Ok(())` if user namespaces work, or `Err` with diagnostic info.
pub fn check_userns_available() -> Result<(), String> {
    let bwrap_path = match get_bwrap_path() {
        Some(p) => p,
        None => return Err("bwrap binary not found".to_string()),
    };

    let output = Command::new(bwrap_path)
        .args(["--unshare-user", "--", "true"])
        .output();

    match output {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            Err(format!(
                "bwrap --unshare-user failed (exit {}): {}",
                o.status.code().unwrap_or(-1),
                stderr.trim()
            ))
        }
        Err(e) => Err(format!("failed to run bwrap: {}", e)),
    }
}

/// Get the bwrap version string.
#[allow(dead_code)]
pub fn version() -> Option<String> {
    let bwrap_path = get_bwrap_path()?;
    Command::new(bwrap_path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
}

/// Builder for constructing bwrap command arguments.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct BwrapCommand {
    args: Vec<String>,
    env_vars: Vec<(String, String)>,
}

impl BwrapCommand {
    /// Create a new bwrap command builder with default isolation settings.
    pub fn new() -> Self {
        Self {
            args: Vec::new(),
            env_vars: Vec::new(),
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Namespace isolation (C-BUILDER: Non-consuming pattern)
    // ─────────────────────────────────────────────────────────────────────

    /// Add default namespace isolation (all namespaces except network).
    ///
    /// We keep network namespace shared because gvproxy needs host networking.
    ///
    /// Note: Mount namespace is implicitly unshared when using bind mounts.
    /// bwrap does not have an explicit --unshare-mount option.
    pub fn with_default_namespaces(&mut self) -> &mut Self {
        // Isolate these namespaces
        // Note: Mount namespace is implicitly unshared when bind mounts are used
        self.args.push("--unshare-user".to_string());
        self.args.push("--unshare-pid".to_string());
        self.args.push("--unshare-ipc".to_string());
        self.args.push("--unshare-uts".to_string());
        // NOTE: We do NOT unshare network - gvproxy needs host networking
        // self.args.push("--unshare-net".to_string());
        self
    }

    /// Enable die-with-parent behavior (shim dies when parent dies).
    pub fn with_die_with_parent(&mut self) -> &mut Self {
        self.args.push("--die-with-parent".to_string());
        self
    }

    /// Add a new session to prevent terminal injection attacks.
    pub fn with_new_session(&mut self) -> &mut Self {
        self.args.push("--new-session".to_string());
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Bind mounts
    // ─────────────────────────────────────────────────────────────────────

    /// Add read-only bind mount.
    pub fn ro_bind(&mut self, src: impl AsRef<Path>, dest: impl AsRef<Path>) -> &mut Self {
        self.args.push("--ro-bind".to_string());
        self.args.push(src.as_ref().to_string_lossy().to_string());
        self.args.push(dest.as_ref().to_string_lossy().to_string());
        self
    }

    /// Add read-only bind mount if source exists.
    pub fn ro_bind_if_exists(
        &mut self,
        src: impl AsRef<Path>,
        dest: impl AsRef<Path>,
    ) -> &mut Self {
        if src.as_ref().exists() {
            self.args.push("--ro-bind".to_string());
            self.args.push(src.as_ref().to_string_lossy().to_string());
            self.args.push(dest.as_ref().to_string_lossy().to_string());
        }
        self
    }

    /// Add read-write bind mount.
    pub fn bind(&mut self, src: impl AsRef<Path>, dest: impl AsRef<Path>) -> &mut Self {
        self.args.push("--bind".to_string());
        self.args.push(src.as_ref().to_string_lossy().to_string());
        self.args.push(dest.as_ref().to_string_lossy().to_string());
        self
    }

    /// Add device bind mount (for /dev/kvm, etc).
    pub fn dev_bind(&mut self, src: impl AsRef<Path>, dest: impl AsRef<Path>) -> &mut Self {
        self.args.push("--dev-bind".to_string());
        self.args.push(src.as_ref().to_string_lossy().to_string());
        self.args.push(dest.as_ref().to_string_lossy().to_string());
        self
    }

    /// Add device bind mount if source exists.
    pub fn dev_bind_if_exists(
        &mut self,
        src: impl AsRef<Path>,
        dest: impl AsRef<Path>,
    ) -> &mut Self {
        if src.as_ref().exists() {
            self.args.push("--dev-bind".to_string());
            self.args.push(src.as_ref().to_string_lossy().to_string());
            self.args.push(dest.as_ref().to_string_lossy().to_string());
        }
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Special mounts
    // ─────────────────────────────────────────────────────────────────────

    /// Mount /dev with default devices.
    pub fn with_dev(&mut self) -> &mut Self {
        self.args.push("--dev".to_string());
        self.args.push("/dev".to_string());
        self
    }

    /// Mount /proc.
    pub fn with_proc(&mut self) -> &mut Self {
        self.args.push("--proc".to_string());
        self.args.push("/proc".to_string());
        self
    }

    /// Mount tmpfs at path.
    pub fn tmpfs(&mut self, path: impl AsRef<Path>) -> &mut Self {
        self.args.push("--tmpfs".to_string());
        self.args.push(path.as_ref().to_string_lossy().to_string());
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Environment settings
    // ─────────────────────────────────────────────────────────────────────

    /// Clear all environment variables.
    pub fn with_clearenv(&mut self) -> &mut Self {
        self.args.push("--clearenv".to_string());
        self
    }

    /// Set an environment variable.
    pub fn setenv(&mut self, key: impl Into<String>, value: impl Into<String>) -> &mut Self {
        self.args.push("--setenv".to_string());
        self.args.push(key.into());
        self.args.push(value.into());
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Security settings
    // ─────────────────────────────────────────────────────────────────────

    /// Add seccomp filter from file descriptor.
    ///
    /// The filter should be passed via fd 3 using process_stdio.
    pub fn with_seccomp_fd(&mut self, fd: i32) -> &mut Self {
        self.args.push("--seccomp".to_string());
        self.args.push(fd.to_string());
        self
    }

    /// Set the working directory inside the sandbox.
    pub fn chdir(&mut self, path: impl AsRef<Path>) -> &mut Self {
        self.args.push("--chdir".to_string());
        self.args.push(path.as_ref().to_string_lossy().to_string());
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Build
    // ─────────────────────────────────────────────────────────────────────

    /// Build the command with the specified executable and arguments.
    ///
    /// Uses the discovered bwrap path (system or bundled).
    ///
    /// # Panics
    ///
    /// Panics if called when `is_available()` returns false. Always check
    /// availability before calling this method.
    pub fn build(&self, executable: impl AsRef<Path>, args: &[String]) -> Command {
        let bwrap_path = get_bwrap_path().expect(
            "BwrapCommand::build() called but bwrap is not available. Check is_available() first.",
        );

        let mut cmd = Command::new(bwrap_path);
        cmd.args(&self.args);
        cmd.arg("--");
        cmd.arg(executable.as_ref());
        cmd.args(args);
        cmd
    }

    /// Get the arguments as a vector (for testing/debugging).
    pub fn get_args(&self) -> &[String] {
        &self.args
    }
}

impl Default for BwrapCommand {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a bwrap command for sandboxing boxlite-shim.
///
/// This sets up the standard isolation environment for the shim process.
///
/// ## Mount Strategy
///
/// The sandbox mounts:
/// - System directories (`/usr`, `/lib`, `/lib64`, `/bin`, `/sbin`) - read-only
/// - Device nodes (`/dev/kvm`, `/dev/net/tun`) - for KVM and networking
/// - BoxLite home directory (`~/.boxlite`) - read-write for runtime data
/// - Shim binary directory - read-only for the binary and bundled libraries
///
/// ## Environment Variables
///
/// After `--clearenv`, we explicitly set:
/// - `PATH` - minimal path for system binaries
/// - `HOME` - set to `/root` (sandbox is isolated)
/// - `LD_LIBRARY_PATH` - **critical** for bundled libraries (libkrun, libgvproxy)
/// - `RUST_LOG` - preserved if set (for debugging)
///
/// ## Known Issues / TODOs
///
/// TODO(security): Consider using `--unshare-net` with explicit network setup
///                 instead of sharing the host network namespace.
/// TODO(security): Add seccomp filter via `--seccomp` fd once filter passing is implemented.
/// TODO(cleanup): The shim directory mount could be more restrictive (specific files only).
pub fn build_shim_command(
    shim_path: &Path,
    shim_args: &[String],
    layout: &FilesystemLayout,
    _security: &SecurityOptions,
) -> Command {
    let mut bwrap = BwrapCommand::new();

    // =========================================================================
    // Namespace and session isolation
    // =========================================================================
    bwrap
        .with_default_namespaces()
        .with_die_with_parent()
        .with_new_session();

    // =========================================================================
    // Mount system directories (read-only)
    // =========================================================================
    bwrap
        .ro_bind_if_exists("/usr", "/usr")
        .ro_bind_if_exists("/lib", "/lib")
        .ro_bind_if_exists("/lib64", "/lib64")
        .ro_bind_if_exists("/bin", "/bin")
        .ro_bind_if_exists("/sbin", "/sbin");

    // =========================================================================
    // Mount devices
    // =========================================================================
    // Mount /dev with basic devices, plus specific access to KVM and TUN
    bwrap
        .with_dev()
        .dev_bind_if_exists("/dev/kvm", "/dev/kvm")
        .dev_bind_if_exists("/dev/net/tun", "/dev/net/tun");

    // Mount /proc for process info
    bwrap.with_proc();

    // Mount /tmp as tmpfs (isolated scratch space)
    bwrap.tmpfs("/tmp");

    // =========================================================================
    // Mount application directories
    // =========================================================================

    // Mount boxlite home directory (read-write for runtime data)
    // This contains: boxes/, images/, db/, logs/, etc.
    bwrap.bind(layout.home_dir(), layout.home_dir());

    // Mount the shim binary's directory (read-only)
    // This is CRITICAL: the shim binary and its bundled libraries (libkrun.so,
    // libgvproxy.so, libkrunfw.so) are in this directory. Without this mount,
    // the shim cannot be executed inside the sandbox.
    //
    // The shim_path might be:
    // - Development: /path/to/boxlite/sdks/python/boxlite/runtime/boxlite-shim
    // - Installed: /usr/lib/boxlite/boxlite-shim (already covered by /usr mount)
    if let Some(shim_dir) = shim_path.parent() {
        // Only mount if not already covered by system mounts
        let shim_dir_str = shim_dir.to_string_lossy();
        if !shim_dir_str.starts_with("/usr")
            && !shim_dir_str.starts_with("/lib")
            && !shim_dir_str.starts_with("/bin")
        {
            bwrap.ro_bind(shim_dir, shim_dir);
            tracing::debug!(
                shim_dir = %shim_dir.display(),
                "Mounted shim directory in sandbox"
            );
        }
    }

    // =========================================================================
    // Environment sanitization
    // =========================================================================
    // Clear all inherited environment variables for security
    bwrap.with_clearenv();

    // Set minimal required environment variables
    bwrap
        .setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .setenv("HOME", "/root");

    // =========================================================================
    // Preserve LD_LIBRARY_PATH for bundled libraries
    // =========================================================================
    // CRITICAL: The shim binary dynamically links against bundled libraries:
    // - libkrun.so (KVM-based VM runtime)
    // - libgvproxy.so (networking)
    // - libkrunfw.so (firmware)
    //
    // These are in the same directory as the shim binary. Without LD_LIBRARY_PATH,
    // the dynamic linker cannot find them and the shim will fail to start.
    //
    // Note: We get LD_LIBRARY_PATH from the parent process (set by util::find_binary_with_libpath)
    if let Ok(ld_library_path) = std::env::var("LD_LIBRARY_PATH") {
        bwrap.setenv("LD_LIBRARY_PATH", ld_library_path);
        tracing::debug!("Preserved LD_LIBRARY_PATH in sandbox");
    } else if let Some(shim_dir) = shim_path.parent() {
        // Fallback: if LD_LIBRARY_PATH not set, use the shim's directory
        // This handles cases where the shim is invoked directly
        bwrap.setenv("LD_LIBRARY_PATH", shim_dir.to_string_lossy().to_string());
        tracing::debug!(
            shim_dir = %shim_dir.display(),
            "Set LD_LIBRARY_PATH to shim directory (fallback)"
        );
    }

    // Preserve debugging environment variables
    if let Ok(rust_log) = std::env::var("RUST_LOG") {
        bwrap.setenv("RUST_LOG", rust_log);
    }
    if let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE") {
        bwrap.setenv("RUST_BACKTRACE", rust_backtrace);
    }

    // Set working directory
    bwrap.chdir("/");

    // Build the final command
    bwrap.build(shim_path, shim_args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bwrap_available() {
        // This test will pass if bwrap is installed
        let available = is_available();
        println!("bwrap available: {}", available);
        if available {
            println!("bwrap version: {:?}", version());
        }
    }

    #[test]
    fn test_bwrap_command_builder() {
        let mut bwrap = BwrapCommand::new();
        bwrap
            .with_default_namespaces()
            .with_die_with_parent()
            .ro_bind("/usr", "/usr")
            .with_dev()
            .with_proc()
            .tmpfs("/tmp")
            .with_clearenv()
            .setenv("PATH", "/usr/bin:/bin");

        let args = bwrap.get_args();

        assert!(args.contains(&"--unshare-user".to_string()));
        assert!(args.contains(&"--unshare-pid".to_string()));
        assert!(args.contains(&"--die-with-parent".to_string()));
        assert!(args.contains(&"--clearenv".to_string()));
        // Note: Mount namespace is implicitly unshared via bind mounts, no --unshare-mount
        // Should NOT contain --unshare-net (we keep network for gvproxy)
        assert!(!args.contains(&"--unshare-net".to_string()));
    }

    #[test]
    fn test_build_command() {
        // Skip if bwrap not available
        if !is_available() {
            println!("Skipping test: bwrap not available");
            return;
        }

        let mut bwrap = BwrapCommand::new();
        bwrap
            .with_default_namespaces()
            .with_clearenv()
            .setenv("FOO", "bar");

        let cmd = bwrap.build(
            Path::new("/usr/bin/echo"),
            &["hello".to_string(), "world".to_string()],
        );

        // Verify command program contains "bwrap" (may be absolute path or just "bwrap")
        let program = cmd.get_program().to_string_lossy();
        assert!(
            program.ends_with("bwrap") || program == "bwrap",
            "Expected program to be bwrap, got: {}",
            program
        );
    }

    #[test]
    fn test_bwrap_non_consuming_pattern() {
        // Verify builder can be reused (non-consuming pattern)
        let mut bwrap = BwrapCommand::new();
        bwrap.with_default_namespaces();

        // Can continue adding to the same builder
        bwrap.ro_bind("/usr", "/usr");
        bwrap.with_clearenv();

        let args = bwrap.get_args();
        assert!(args.contains(&"--unshare-user".to_string()));
        assert!(args.contains(&"--ro-bind".to_string()));
        assert!(args.contains(&"--clearenv".to_string()));
    }

    #[test]
    fn test_bwrap_conditional_mount() {
        let mut bwrap = BwrapCommand::new();

        // Conditional binding doesn't require reassignment
        bwrap.ro_bind_if_exists("/nonexistent", "/nonexistent");
        bwrap.dev_bind_if_exists("/nonexistent_dev", "/nonexistent_dev");

        let args = bwrap.get_args();
        // Non-existent paths should not be added
        assert!(!args.contains(&"/nonexistent".to_string()));
        assert!(!args.contains(&"/nonexistent_dev".to_string()));
    }

    /// Verify check_userns_available() returns a well-formed result.
    /// On CI/dev machines this will either succeed or fail with a clear message.
    #[test]
    fn test_check_userns_available() {
        let result = check_userns_available();
        match result {
            Ok(()) => {
                // bwrap user namespaces are available — nothing else to verify
            }
            Err(e) => {
                // Should contain diagnostic info (exit code + stderr)
                assert!(!e.is_empty(), "Error message should not be empty");
            }
        }
    }
}
