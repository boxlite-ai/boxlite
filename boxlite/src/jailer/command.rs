//! Command building for isolated process execution.
//!
//! This module provides the command building logic for spawning
//! boxlite-shim in an isolated environment.
//!
//! # Platform-specific Behavior
//!
//! - **Linux**: Wraps with bubblewrap (bwrap) for namespace isolation
//! - **macOS**: Wraps with sandbox-exec for Seatbelt sandbox
//! - **Other**: Falls back to direct execution with rlimits only
//!
//! # Pre-exec Hook
//!
//! All commands include a `pre_exec` hook that runs after `fork()` but
//! before `exec()`. This hook applies:
//! - FD cleanup (closes inherited file descriptors)
//! - Resource limits (rlimits)
//! - Cgroup membership (Linux only)

use crate::jailer::builder::Jailer;
use crate::jailer::pre_exec;
use std::path::Path;
use std::process::Command;

impl Jailer {
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
    ///
    /// # Errors
    ///
    /// Returns an error if cgroup creation fails on Linux. On macOS, this
    /// function always succeeds (no-op).
    ///
    /// Note: Cgroup failures are treated as warnings, not errors, to allow
    /// boxes to run without cgroup limits if the system doesn't support them.
    pub fn setup_pre_spawn(&self) -> boxlite_shared::errors::BoxliteResult<()> {
        #[cfg(target_os = "linux")]
        {
            use crate::jailer::{
                bwrap,
                cgroup::{CgroupConfig, setup_cgroup},
            };
            use boxlite_shared::errors::BoxliteError;

            // Preflight: verify bwrap can create user namespaces before proceeding.
            // Catches AppArmor restrictions and missing kernel support early.
            if self.security.jailer_enabled
                && bwrap::is_available()
                && let Err(reason) = bwrap::check_userns_available()
            {
                return Err(BoxliteError::Config(format!(
                    "Sandbox preflight failed: bwrap cannot create user namespaces.\n\
                     {reason}\n\n\
                     This usually means unprivileged user namespaces are restricted \
                     on this system.\n\n\
                     To fix, see: https://boxlite.dev/docs/faq#sandbox-userns\n\n\
                     To skip the sandbox (development only):\n  \
                       SecurityOptions {{ jailer_enabled: false, .. }}"
                )));
            }

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
    ///
    /// # Arguments
    ///
    /// * `binary` - Path to the shim binary to execute
    /// * `args` - Arguments to pass to the shim
    ///
    /// # Returns
    ///
    /// A `Command` configured with appropriate isolation for the platform.
    pub fn build_command(&self, binary: &Path, args: &[String]) -> Command {
        if !self.security.jailer_enabled {
            tracing::info!("Jailer disabled, running shim without sandbox isolation");
            return self.build_command_direct(binary, args);
        }

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
    // Linux command building
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "linux")]
    fn build_command_linux(&self, binary: &Path, args: &[String]) -> Command {
        use crate::jailer::{bwrap, cgroup};

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
        let pid_file_path = self.build_pid_file_path();

        pre_exec::add_pre_exec_hook(&mut cmd, resource_limits, cgroup_procs_path, pid_file_path);
        cmd
    }

    #[cfg(target_os = "linux")]
    fn build_bwrap_command(&self, binary: &Path, args: &[String]) -> Command {
        use crate::jailer::{bwrap, shim_copy};

        // =====================================================================
        // Firecracker pattern: Copy shim binary and libraries to box directory
        // =====================================================================
        // This ensures:
        // 1. No external bind mounts needed (works with root user)
        // 2. Complete memory isolation between boxes (no shared .text section)
        // 3. Each box has its own copy of the shim and libraries

        let (shim_binary, bin_dir) = match shim_copy::copy_shim_to_box(binary, &self.box_dir) {
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

        let mut bwrap = bwrap::BwrapCommand::new();

        // =====================================================================
        // Namespace and session isolation
        // =====================================================================
        bwrap
            .with_default_namespaces()
            .with_die_with_parent()
            .with_new_session();

        // =====================================================================
        // System directories (read-only)
        // =====================================================================
        // TODO(security): Eliminate /usr, /lib, /bin, /sbin bind mounts by statically
        // linking boxlite-shim with musl. This requires:
        // 1. Build libkrun with musl (CC=musl-gcc)
        // 2. Build libgvproxy with musl (CGO_ENABLED=1 CC=musl-gcc)
        // 3. Build boxlite-shim with --target x86_64-unknown-linux-musl
        // 4. Remove these ro_bind_if_exists calls below
        bwrap
            .ro_bind_if_exists("/usr", "/usr")
            .ro_bind_if_exists("/lib", "/lib")
            .ro_bind_if_exists("/lib64", "/lib64")
            .ro_bind_if_exists("/bin", "/bin")
            .ro_bind_if_exists("/sbin", "/sbin");

        // =====================================================================
        // Devices and special mounts
        // =====================================================================
        bwrap
            .with_dev()
            .dev_bind_if_exists("/dev/kvm", "/dev/kvm")
            .dev_bind_if_exists("/dev/net/tun", "/dev/net/tun")
            .with_proc()
            .tmpfs("/tmp");

        // =====================================================================
        // Mount minimal directories for security isolation
        // =====================================================================
        // Only this box's directory and required runtime directories are accessible

        // 1. Mount this box's directory (read-write)
        //    Contains: bin/, sockets/, shared/, disk.qcow2, guest-rootfs.qcow2
        //    The shim binary and libraries are now INSIDE this directory
        bwrap.bind(&self.box_dir, &self.box_dir);
        tracing::debug!(box_dir = %self.box_dir.display(), "bwrap: mounted box directory");

        // Get boxlite home directory for other mounts
        if let Some(boxes_dir) = self.box_dir.parent()
            && let Some(home_dir) = boxes_dir.parent()
        {
            // 2. Mount logs directory (read-write for shim logging + console output)
            let logs_dir = home_dir.join("logs");
            if logs_dir.exists() {
                bwrap.bind(&logs_dir, &logs_dir);
                tracing::debug!(logs_dir = %logs_dir.display(), "bwrap: mounted logs directory");
            }

            // 3. Mount tmp directory (read-write for rootfs preparation)
            //    Contains: temporary rootfs mounts during box creation
            let tmp_dir = home_dir.join("tmp");
            if tmp_dir.exists() {
                bwrap.bind(&tmp_dir, &tmp_dir);
                tracing::debug!(tmp_dir = %tmp_dir.display(), "bwrap: mounted tmp directory");
            }

            // 4. Mount images directory (read-only for extracted OCI layers)
            //    Contains: extracted layer data used for rootfs
            let images_dir = home_dir.join("images");
            if images_dir.exists() {
                bwrap.ro_bind(&images_dir, &images_dir);
                tracing::debug!(images_dir = %images_dir.display(), "bwrap: mounted images directory (ro)");
            }
        }

        // NOTE: No external shim directory bind mount needed!
        // The shim and libraries are now copied into box_dir/bin/

        // =====================================================================
        // Environment sanitization
        // =====================================================================
        bwrap
            .with_clearenv()
            .setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .setenv("HOME", "/root");

        // Set LD_LIBRARY_PATH to the copied libraries directory
        // This is inside box_dir, so no external bind mount needed
        bwrap.setenv("LD_LIBRARY_PATH", bin_dir.to_string_lossy().to_string());
        tracing::debug!(ld_library_path = %bin_dir.display(), "Set LD_LIBRARY_PATH to copied libs directory");

        // Preserve debugging environment variables
        if let Ok(rust_log) = std::env::var("RUST_LOG") {
            bwrap.setenv("RUST_LOG", rust_log);
        }
        if let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE") {
            bwrap.setenv("RUST_BACKTRACE", rust_backtrace);
        }

        bwrap.chdir("/");

        bwrap.build(&shim_binary, args)
    }

    // ─────────────────────────────────────────────────────────────────────
    // macOS command building
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "macos")]
    fn build_command_macos(&self, binary: &Path, args: &[String]) -> Command {
        use crate::jailer::platform::macos;

        let mut cmd = if macos::is_sandbox_available() {
            tracing::info!("Building sandbox-exec isolated command");
            let (sandbox_cmd, sandbox_args) =
                macos::get_sandbox_exec_args(&self.security, &self.box_dir, binary, &self.volumes);
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
        let pid_file_path = self.build_pid_file_path();
        pre_exec::add_pre_exec_hook(&mut cmd, resource_limits, None, pid_file_path);
        cmd
    }

    // ─────────────────────────────────────────────────────────────────────
    // Direct command (no sandbox) — used when jailer disabled or platform unsupported
    // ─────────────────────────────────────────────────────────────────────

    fn build_command_direct(&self, binary: &Path, args: &[String]) -> Command {
        let mut cmd = Command::new(binary);
        cmd.args(args);

        let resource_limits = self.security.resource_limits.clone();
        let pid_file_path = self.build_pid_file_path();
        pre_exec::add_pre_exec_hook(&mut cmd, resource_limits, None, pid_file_path);
        cmd
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helper methods
    // ─────────────────────────────────────────────────────────────────────

    /// Build the PID file path as a CString for use in pre_exec hook.
    ///
    /// Returns the path to `{box_dir}/shim.pid` as a CString, ready for
    /// async-signal-safe operations in the pre_exec context.
    fn build_pid_file_path(&self) -> Option<std::ffi::CString> {
        let pid_file = self.box_dir.join("shim.pid");
        std::ffi::CString::new(pid_file.to_string_lossy().as_bytes()).ok()
    }
}

#[cfg(test)]
mod tests {
    use crate::jailer::builder::Jailer;
    use crate::jailer::config::SecurityOptions;
    use std::path::Path;

    /// When `jailer_enabled=false`, build_command must return a direct command
    /// using the binary as the program — no bwrap, no sandbox-exec.
    #[test]
    fn test_build_command_jailer_disabled_returns_direct() {
        let security = SecurityOptions {
            jailer_enabled: false,
            ..SecurityOptions::default()
        };
        let jailer = Jailer::new("test-box", "/tmp/test-box").with_security(security);

        let binary = Path::new("/usr/bin/boxlite-shim");
        let args = vec!["--listen".to_string(), "vsock://2:2695".to_string()];
        let cmd = jailer.build_command(binary, &args);

        // Direct command: program IS the binary itself
        assert_eq!(cmd.get_program(), binary);

        // Args passed through
        let cmd_args: Vec<_> = cmd.get_args().collect();
        assert_eq!(cmd_args, &["--listen", "vsock://2:2695"]);
    }

    /// When `jailer_enabled=true`, on macOS (with sandbox-exec) or Linux (with bwrap),
    /// the program should NOT be the binary directly — it should be wrapped.
    /// On platforms without a sandbox, it falls back to direct.
    #[test]
    fn test_build_command_jailer_enabled_wraps_binary() {
        let security = SecurityOptions {
            jailer_enabled: true,
            ..SecurityOptions::default()
        };
        let jailer = Jailer::new("test-box", "/tmp/test-box").with_security(security);

        let binary = Path::new("/usr/bin/boxlite-shim");
        let args = vec!["--listen".to_string()];
        let cmd = jailer.build_command(binary, &args);

        // On macOS: should be "sandbox-exec" (if available) or binary (fallback)
        // On Linux: should be "bwrap" (if available) or binary (fallback)
        // On other: always direct (binary)
        // We can't assert the exact program without knowing the platform,
        // but we verify the command was constructed without panics.
        let _program = cmd.get_program();
    }

    /// Verify that build_command_direct is accessible regardless of platform
    /// (previously was gated behind #[cfg(not(any(linux, macos)))]).
    #[test]
    fn test_build_command_direct_available_on_all_platforms() {
        let jailer = Jailer::new("test-box", "/tmp/test-box");

        let binary = Path::new("/usr/bin/boxlite-shim");
        let args = vec!["--arg1".to_string()];
        let cmd = jailer.build_command_direct(binary, &args);

        assert_eq!(cmd.get_program(), binary);
        let cmd_args: Vec<_> = cmd.get_args().collect();
        assert_eq!(cmd_args, &["--arg1"]);
    }

    /// SecurityOptions::development() should have jailer_enabled=false.
    /// This ensures development preset always bypasses the jailer.
    #[test]
    fn test_development_preset_disables_jailer() {
        let security = SecurityOptions::development();
        let jailer = Jailer::new("test-box", "/tmp/test-box").with_security(security);

        let binary = Path::new("/usr/bin/boxlite-shim");
        let cmd = jailer.build_command(binary, &[]);

        // Development preset → jailer_enabled=false → direct command
        assert_eq!(cmd.get_program(), binary);
    }

    /// When jailer is disabled, setup_pre_spawn should skip the userns preflight
    /// and always succeed.
    #[test]
    fn test_setup_pre_spawn_jailer_disabled_skips_userns_check() {
        let security = SecurityOptions {
            jailer_enabled: false,
            ..SecurityOptions::default()
        };
        let jailer = Jailer::new("test-box", "/tmp/test-box").with_security(security);

        // Should always succeed — no preflight when jailer is disabled
        assert!(jailer.setup_pre_spawn().is_ok());
    }
}
