//! Bubblewrap (bwrap) command builder for Linux isolation.
//!
//! This module builds the `bwrap` command with appropriate arguments
//! for sandboxing the boxlite-shim process.
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
use std::path::Path;
use std::process::Command;

/// Check if bubblewrap (bwrap) is available on the system.
pub fn is_available() -> bool {
    Command::new("bwrap")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Get the bwrap version string.
#[allow(dead_code)]
pub fn version() -> Option<String> {
    Command::new("bwrap")
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

    /// Add default namespace isolation (all namespaces except network).
    ///
    /// We keep network namespace shared because gvproxy needs host networking.
    pub fn with_default_namespaces(mut self) -> Self {
        // Isolate these namespaces
        self.args.push("--unshare-user".to_string());
        self.args.push("--unshare-mount".to_string());
        self.args.push("--unshare-pid".to_string());
        self.args.push("--unshare-ipc".to_string());
        self.args.push("--unshare-uts".to_string());
        // NOTE: We do NOT unshare network - gvproxy needs host networking
        // self.args.push("--unshare-net".to_string());
        self
    }

    /// Enable die-with-parent behavior (shim dies when parent dies).
    pub fn with_die_with_parent(mut self) -> Self {
        self.args.push("--die-with-parent".to_string());
        self
    }

    /// Add a new session to prevent terminal injection attacks.
    pub fn with_new_session(mut self) -> Self {
        self.args.push("--new-session".to_string());
        self
    }

    /// Add read-only bind mount.
    pub fn ro_bind(mut self, src: impl AsRef<Path>, dest: impl AsRef<Path>) -> Self {
        self.args.push("--ro-bind".to_string());
        self.args.push(src.as_ref().to_string_lossy().to_string());
        self.args.push(dest.as_ref().to_string_lossy().to_string());
        self
    }

    /// Add read-only bind mount if source exists.
    pub fn ro_bind_if_exists(self, src: impl AsRef<Path>, dest: impl AsRef<Path>) -> Self {
        if src.as_ref().exists() {
            self.ro_bind(src, dest)
        } else {
            self
        }
    }

    /// Add read-write bind mount.
    pub fn bind(mut self, src: impl AsRef<Path>, dest: impl AsRef<Path>) -> Self {
        self.args.push("--bind".to_string());
        self.args.push(src.as_ref().to_string_lossy().to_string());
        self.args.push(dest.as_ref().to_string_lossy().to_string());
        self
    }

    /// Add device bind mount (for /dev/kvm, etc).
    pub fn dev_bind(mut self, src: impl AsRef<Path>, dest: impl AsRef<Path>) -> Self {
        self.args.push("--dev-bind".to_string());
        self.args.push(src.as_ref().to_string_lossy().to_string());
        self.args.push(dest.as_ref().to_string_lossy().to_string());
        self
    }

    /// Add device bind mount if source exists.
    pub fn dev_bind_if_exists(self, src: impl AsRef<Path>, dest: impl AsRef<Path>) -> Self {
        if src.as_ref().exists() {
            self.dev_bind(src, dest)
        } else {
            self
        }
    }

    /// Mount /dev with default devices.
    pub fn with_dev(mut self) -> Self {
        self.args.push("--dev".to_string());
        self.args.push("/dev".to_string());
        self
    }

    /// Mount /proc.
    pub fn with_proc(mut self) -> Self {
        self.args.push("--proc".to_string());
        self.args.push("/proc".to_string());
        self
    }

    /// Mount tmpfs at path.
    pub fn tmpfs(mut self, path: impl AsRef<Path>) -> Self {
        self.args.push("--tmpfs".to_string());
        self.args.push(path.as_ref().to_string_lossy().to_string());
        self
    }

    /// Clear all environment variables.
    pub fn with_clearenv(mut self) -> Self {
        self.args.push("--clearenv".to_string());
        self
    }

    /// Set an environment variable.
    pub fn setenv(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.args.push("--setenv".to_string());
        self.args.push(key.into());
        self.args.push(value.into());
        self
    }

    /// Add seccomp filter from file descriptor.
    ///
    /// The filter should be passed via fd 3 using process_stdio.
    pub fn with_seccomp_fd(mut self, fd: i32) -> Self {
        self.args.push("--seccomp".to_string());
        self.args.push(fd.to_string());
        self
    }

    /// Set the working directory inside the sandbox.
    pub fn chdir(mut self, path: impl AsRef<Path>) -> Self {
        self.args.push("--chdir".to_string());
        self.args.push(path.as_ref().to_string_lossy().to_string());
        self
    }

    /// Build the command with the specified executable and arguments.
    pub fn build(self, executable: impl AsRef<Path>, args: &[String]) -> Command {
        let mut cmd = Command::new("bwrap");
        cmd.args(&self.args);
        cmd.arg("--");
        cmd.arg(executable.as_ref());
        cmd.args(args);
        cmd
    }

    /// Get the arguments as a vector (for testing/debugging).
    pub fn args(&self) -> &[String] {
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
pub fn build_shim_command(
    shim_path: &Path,
    shim_args: &[String],
    layout: &FilesystemLayout,
    _security: &SecurityOptions,
) -> Command {
    let mut bwrap = BwrapCommand::new()
        .with_default_namespaces()
        .with_die_with_parent()
        .with_new_session();

    // Mount system directories read-only
    bwrap = bwrap
        .ro_bind_if_exists("/usr", "/usr")
        .ro_bind_if_exists("/lib", "/lib")
        .ro_bind_if_exists("/lib64", "/lib64")
        .ro_bind_if_exists("/bin", "/bin")
        .ro_bind_if_exists("/sbin", "/sbin");

    // Mount /dev with access to KVM
    bwrap = bwrap
        .with_dev()
        .dev_bind_if_exists("/dev/kvm", "/dev/kvm")
        .dev_bind_if_exists("/dev/net/tun", "/dev/net/tun");

    // Mount /proc
    bwrap = bwrap.with_proc();

    // Mount /tmp as tmpfs
    bwrap = bwrap.tmpfs("/tmp");

    // Mount boxlite home directory (read-write for data)
    bwrap = bwrap.bind(layout.home_dir(), layout.home_dir());

    // Environment sanitization
    bwrap = bwrap.with_clearenv();

    // Set minimal required environment variables
    bwrap = bwrap
        .setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .setenv("HOME", "/root");

    // Preserve RUST_LOG if set
    if let Ok(rust_log) = std::env::var("RUST_LOG") {
        bwrap = bwrap.setenv("RUST_LOG", rust_log);
    }

    // Set working directory
    bwrap = bwrap.chdir("/");

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
        let bwrap = BwrapCommand::new()
            .with_default_namespaces()
            .with_die_with_parent()
            .ro_bind("/usr", "/usr")
            .with_dev()
            .with_proc()
            .tmpfs("/tmp")
            .with_clearenv()
            .setenv("PATH", "/usr/bin:/bin");

        let args = bwrap.args();

        assert!(args.contains(&"--unshare-user".to_string()));
        assert!(args.contains(&"--unshare-mount".to_string()));
        assert!(args.contains(&"--die-with-parent".to_string()));
        assert!(args.contains(&"--clearenv".to_string()));
        // Should NOT contain --unshare-net (we keep network for gvproxy)
        assert!(!args.contains(&"--unshare-net".to_string()));
    }

    #[test]
    fn test_build_command() {
        let bwrap = BwrapCommand::new()
            .with_default_namespaces()
            .with_clearenv()
            .setenv("FOO", "bar");

        let cmd = bwrap.build(
            Path::new("/usr/bin/echo"),
            &["hello".to_string(), "world".to_string()],
        );

        // Verify command is bwrap
        assert_eq!(cmd.get_program(), "bwrap");
    }
}
