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
//! Jail (trait — public contract, what callers see)
//! │   prepare()  → pre-spawn setup
//! │   command()  → confined command, ready to spawn
//! │
//! └── Jailer<S: Sandbox> (struct — implements Jail)
//!     │   translates SecurityOptions → SandboxContext
//!     │   delegates to S, adds pre_exec hook
//!     │
//!     └── Sandbox (trait — internal, platform-specific wrapping)
//!         ├── BwrapSandbox       (Linux — bubblewrap)
//!         ├── SeatbeltSandbox    (macOS — sandbox-exec)
//!         └── NoopSandbox        (unsupported / jailer disabled)
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
//! let jail = JailerBuilder::new()
//!     .with_box_id(&box_id)
//!     .with_layout(layout)
//!     .with_security(security)
//!     .build()?;
//!
//! jail.prepare()?;
//! let cmd = jail.command(&binary, &args);
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
pub(crate) mod sandbox;
pub(crate) mod shim_copy;

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

// ============================================================================
// Public re-exports
// ============================================================================

// Core types
pub use crate::runtime::advanced_options::{ResourceLimits, SecurityOptions};
pub use builder::JailerBuilder;
pub use error::{ConfigError, IsolationError, JailerError, SystemError};
pub use sandbox::{NoopSandbox, PathAccess, PlatformSandbox, Sandbox, SandboxContext};

// Volume specification (convenience re-export)
pub use crate::runtime::options::VolumeSpec;

// Linux-specific exports
#[cfg(target_os = "linux")]
pub use bwrap::{build_shim_command, is_available as is_bwrap_available};
#[cfg(target_os = "linux")]
pub use sandbox::BwrapSandbox;
#[cfg(target_os = "linux")]
pub use seccomp::SeccompRole;

// macOS-specific exports
#[cfg(target_os = "macos")]
pub use sandbox::SeatbeltSandbox;
#[cfg(target_os = "macos")]
pub use sandbox::seatbelt::{
    SANDBOX_EXEC_PATH, get_base_policy, get_network_policy, is_sandbox_available,
};

// ============================================================================
// Jail trait — public contract
// ============================================================================

use boxlite_shared::errors::BoxliteResult;
use std::path::Path;
use std::process::Command;

/// Process confinement for subprocess isolation.
///
/// Provides the public contract for building isolated commands.
/// Callers don't know or care about the mechanism (bwrap, sandbox-exec, etc.).
///
/// ```ignore
/// let jail: &impl Jail = &jailer;
/// jail.prepare()?;
/// let cmd = jail.command(&binary, &args);
/// cmd.spawn()?;
/// ```
pub trait Jail: Send + Sync {
    /// Pre-spawn setup. Call before `command()`.
    ///
    /// On Linux: userns preflight + cgroup creation.
    /// On macOS: no-op.
    fn prepare(&self) -> BoxliteResult<()>;

    /// Build a confined command, ready to spawn.
    ///
    /// Returns a `Command` with sandbox wrapping and pre_exec hook
    /// (FD cleanup, rlimits, cgroup join, PID file).
    fn command(&self, binary: &Path, args: &[String]) -> Command;
}

// ============================================================================
// Jailer<S: Sandbox> — implements Jail
// ============================================================================

use crate::runtime::layout::BoxFilesystemLayout;
use std::path::PathBuf;

// ============================================================================
// Path access rules — granular filesystem permissions
// ============================================================================

/// Build granular [`PathAccess`] rules from the box layout.
///
/// Instead of granting access to the entire box directory, each file and
/// directory is listed individually with the minimum required access level.
///
/// ## Sandbox filesystem layout
///
/// ```text
/// {box_dir}/                          # NOT granted wholesale
/// ├── bin/                        [RO]  # copied shim binary + bundled libs
/// ├── shared/                     [RO]  # guest-visible container images
/// ├── rootfs-base                 [RO]  # reflinked base rootfs (qcow2 backing)
/// ├── sockets/                    [RW]  # libkrun vsock/unix sockets
/// ├── logs/                       [RW]  # shim logging + VM console output
/// │   ├── boxlite-shim.log                # tracing_appender daily log
/// │   └── console.log                     # libkrun serial console (krun_set_console_output)
/// ├── exit                        [RW]  # crash_capture ExitInfo JSON
/// ├── root.qcow2                  [RW]  # VM root disk image
/// ├── guest-rootfs.qcow2          [RW]  # guest rootfs COW overlay
/// ├── mounts/                     [--]  # EXCLUDED: host writes, shim reads via shared/
/// ├── shim.pid                    [--]  # EXCLUDED: written by pre_exec (before sandbox)
/// └── shim.stderr                 [--]  # EXCLUDED: host creates before spawn
///
/// Fallback (when reflink unavailable):
/// ~/.boxlite/rootfs/              [RO]  # external rootfs backing directory
///
/// User volumes:
/// {host_path}                     [per VolumeSpec.read_only]
/// ```
fn build_path_access(layout: &BoxFilesystemLayout, volumes: &[VolumeSpec]) -> Vec<PathAccess> {
    let mut paths = Vec::new();

    // Writable directories (shim creates files inside these at runtime)
    // Note: mounts_dir not included — host writes before spawn, shim accesses via shared_dir
    for dir in [layout.sockets_dir(), layout.logs_dir()] {
        if dir.exists() {
            paths.push(PathAccess {
                path: dir,
                writable: true,
            });
        }
    }

    // Writable files (pre-created before sandbox for bind-mounting)
    // Note: console_output_path() not listed — lives inside logs/ [RW subpath]
    for file in [
        layout.exit_file_path(),
        layout.disk_path(),
        layout.guest_rootfs_disk_path(),
    ] {
        if file.exists() {
            paths.push(PathAccess {
                path: file,
                writable: true,
            });
        }
    }

    // Read-only directories (shim reads but never writes)
    for dir in [layout.bin_dir(), layout.shared_dir()] {
        if dir.exists() {
            paths.push(PathAccess {
                path: dir,
                writable: false,
            });
        }
    }

    // Rootfs backing file: prefer box-local reflink, fallback to home_dir/rootfs/
    let local_base = layout.rootfs_base_path();
    if local_base.exists() {
        paths.push(PathAccess {
            path: local_base,
            writable: false,
        });
    } else if let Some(rootfs_dir) = layout
        .root()
        .parent()
        .and_then(|boxes| boxes.parent())
        .map(|home| home.join("rootfs"))
        .filter(|p| p.exists())
    {
        paths.push(PathAccess {
            path: rootfs_dir,
            writable: false,
        });
    }

    // User volumes
    for vol in volumes {
        let p = PathBuf::from(&vol.host_path);
        if p.exists() {
            paths.push(PathAccess {
                path: p,
                writable: !vol.read_only,
            });
        }
    }

    paths
}

/// Jailer provides process isolation for boxlite-shim.
///
/// Encapsulates security configuration and delegates to a [`Sandbox`]
/// for platform-specific wrapping. All common isolation (FD cleanup,
/// rlimits, cgroup join) is applied via `pre_exec` hook.
///
/// Construct via [`JailerBuilder`]:
///
/// ```ignore
/// use boxlite::jailer::{Jail, JailerBuilder};
///
/// let jail = JailerBuilder::new()
///     .with_box_id(&box_id)
///     .with_layout(layout)
///     .with_security(security)
///     .build()?;
///
/// jail.prepare()?;
/// let cmd = jail.command(&binary, &args);
/// cmd.spawn()?;
/// ```
#[derive(Debug)]
pub struct Jailer<S: Sandbox> {
    /// Platform-specific sandbox implementation.
    sandbox: S,
    /// Security configuration options.
    pub(crate) security: SecurityOptions,
    /// Volume mounts (for sandbox path restrictions).
    pub(crate) volumes: Vec<VolumeSpec>,
    /// Unique box identifier.
    pub(crate) box_id: String,
    /// Box filesystem layout (provides typed path accessors).
    pub(crate) layout: BoxFilesystemLayout,
}

impl<S: Sandbox> Jail for Jailer<S> {
    fn prepare(&self) -> BoxliteResult<()> {
        if !self.security.jailer_enabled {
            return Ok(());
        }
        self.sandbox.setup(&self.context())
    }

    fn command(&self, binary: &Path, args: &[String]) -> Command {
        // Pre-create writable files + dirs for sandbox bind-mounting
        if self.security.jailer_enabled {
            let _ = std::fs::create_dir_all(self.layout.logs_dir());
            for path in [
                self.layout.exit_file_path(),
                self.layout.console_output_path(),
            ] {
                if !path.exists() {
                    let _ = std::fs::File::create(&path);
                }
            }
        }

        let ctx = self.context();

        // Shim copy (Firecracker pattern) — shared for both platforms
        let (effective_binary, bin_dir) = if self.security.jailer_enabled {
            match shim_copy::copy_shim_to_box(binary, self.layout.root()) {
                Ok(copied) => {
                    let dir = copied.parent().unwrap_or(self.layout.root()).to_path_buf();
                    tracing::info!(
                        original = %binary.display(),
                        copied = %copied.display(),
                        "Using copied shim binary (Firecracker pattern)"
                    );
                    (copied, Some(dir))
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to copy shim, using original");
                    (binary.to_path_buf(), None)
                }
            }
        } else {
            (binary.to_path_buf(), None)
        };

        let mut cmd = if self.security.jailer_enabled && self.sandbox.is_available() {
            tracing::info!(sandbox = self.sandbox.name(), "Building confined command");
            self.sandbox.wrap(&ctx, &effective_binary, args)
        } else {
            if self.security.jailer_enabled {
                tracing::warn!("Sandbox not available, falling back to direct command");
            } else {
                tracing::info!("Jailer disabled, running shim without sandbox isolation");
            }
            let mut cmd = Command::new(&effective_binary);
            cmd.args(args);
            cmd
        };

        // LD_LIBRARY_PATH for copied libraries (shared for both platforms)
        if let Some(ref dir) = bin_dir {
            cmd.env("LD_LIBRARY_PATH", dir);
        }

        // Pre-exec hook: FD cleanup, rlimits, cgroup join, PID file
        let resource_limits = self.security.resource_limits.clone();
        let cgroup_procs = self.sandbox.cgroup_procs_path(&ctx);
        let pid_file = self.pid_file_path();
        pre_exec::add_pre_exec_hook(&mut cmd, resource_limits, cgroup_procs, pid_file);
        cmd
    }
}

impl<S: Sandbox> Jailer<S> {
    /// Get the security options.
    pub fn security(&self) -> &SecurityOptions {
        &self.security
    }

    /// Get mutable reference to security options.
    pub fn security_mut(&mut self) -> &mut SecurityOptions {
        &mut self.security
    }

    /// Get the volumes.
    pub fn volumes(&self) -> &[VolumeSpec] {
        &self.volumes
    }

    /// Get the box ID.
    pub fn box_id(&self) -> &str {
        &self.box_id
    }

    /// Get the box directory.
    pub fn box_dir(&self) -> &Path {
        self.layout.root()
    }

    /// Get the box filesystem layout.
    pub fn layout(&self) -> &BoxFilesystemLayout {
        &self.layout
    }

    /// Get the resource limits.
    pub fn resource_limits(&self) -> &ResourceLimits {
        &self.security.resource_limits
    }

    /// Translate SecurityOptions → SandboxContext.
    ///
    /// Delegates to [`build_path_access`] for granular filesystem rules.
    fn context(&self) -> SandboxContext<'_> {
        SandboxContext {
            id: &self.box_id,
            paths: build_path_access(&self.layout, &self.volumes),
            resource_limits: &self.security.resource_limits,
            network_enabled: self.security.network_enabled,
            sandbox_profile: self.security.sandbox_profile.as_deref(),
        }
    }

    /// Build the PID file path as a CString for the pre_exec hook.
    fn pid_file_path(&self) -> Option<std::ffi::CString> {
        let pid_file = self.layout.pid_file_path();
        std::ffi::CString::new(pid_file.to_string_lossy().as_bytes()).ok()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::layout::FsLayoutConfig;
    use tempfile::tempdir;

    fn test_layout(box_dir: PathBuf) -> BoxFilesystemLayout {
        BoxFilesystemLayout::new(box_dir, FsLayoutConfig::without_bind_mount(), false)
    }

    #[test]
    fn test_build_path_access_empty_box_dir() {
        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path().to_path_buf());

        let paths = build_path_access(&layout, &[]);

        // Empty box dir: no subdirectories exist yet, so no paths
        assert!(paths.is_empty(), "No paths for empty box dir");
    }

    #[test]
    fn test_build_path_access_writable_dirs() {
        let dir = tempdir().unwrap();
        let box_dir = dir.path().to_path_buf();
        let layout = test_layout(box_dir.clone());

        // Create writable dirs the shim would write to
        // Note: mounts_dir is NOT included — host writes before spawn, shim reads via shared_dir
        std::fs::create_dir_all(layout.sockets_dir()).unwrap();
        std::fs::create_dir_all(layout.logs_dir()).unwrap();

        let paths = build_path_access(&layout, &[]);

        let writable_dirs: Vec<_> = paths
            .iter()
            .filter(|p| p.writable && p.path.is_dir())
            .collect();
        assert_eq!(
            writable_dirs.len(),
            2,
            "Should have 2 writable dirs (sockets, logs)"
        );

        // All should be writable
        for pa in &writable_dirs {
            assert!(pa.writable);
        }
    }

    #[test]
    fn test_build_path_access_writable_files() {
        let dir = tempdir().unwrap();
        let box_dir = dir.path().to_path_buf();
        let layout = test_layout(box_dir.clone());

        // Pre-create writable files (as the Jailer::command() does)
        // Note: console_output_path() is inside logs/ [RW subpath], not a standalone file grant
        std::fs::File::create(layout.exit_file_path()).unwrap();

        let paths = build_path_access(&layout, &[]);

        let writable_files: Vec<_> = paths
            .iter()
            .filter(|p| p.writable && p.path.is_file())
            .collect();
        assert_eq!(
            writable_files.len(),
            1,
            "exit only (console.log covered by logs/ subpath)"
        );
    }

    #[test]
    fn test_build_path_access_ro_dirs() {
        let dir = tempdir().unwrap();
        let box_dir = dir.path().to_path_buf();
        let layout = test_layout(box_dir.clone());

        // Create read-only dirs
        std::fs::create_dir_all(layout.bin_dir()).unwrap();
        std::fs::create_dir_all(layout.shared_dir()).unwrap();

        let paths = build_path_access(&layout, &[]);

        let ro_dirs: Vec<_> = paths.iter().filter(|p| !p.writable).collect();
        assert_eq!(ro_dirs.len(), 2, "bin/ + shared/ should be read-only");
    }

    #[test]
    fn test_build_path_access_reflinked_rootfs_base() {
        let dir = tempdir().unwrap();
        let box_dir = dir.path().to_path_buf();
        let layout = test_layout(box_dir.clone());

        // Simulate reflinked rootfs base inside box_dir
        std::fs::write(layout.rootfs_base_path(), "fake-rootfs").unwrap();

        let paths = build_path_access(&layout, &[]);

        let rootfs_paths: Vec<_> = paths
            .iter()
            .filter(|p| p.path == layout.rootfs_base_path())
            .collect();
        assert_eq!(rootfs_paths.len(), 1, "Should have rootfs base path");
        assert!(!rootfs_paths[0].writable, "Rootfs base should be read-only");
    }

    #[test]
    fn test_build_path_access_fallback_rootfs_dir() {
        // Simulate the home_dir/boxes/{id} structure
        let dir = tempdir().unwrap();
        let home_dir = dir.path().to_path_buf();
        let boxes_dir = home_dir.join("boxes");
        let box_dir = boxes_dir.join("test-box");
        std::fs::create_dir_all(&box_dir).unwrap();

        // Create home_dir/rootfs/ (the fallback)
        let rootfs_dir = home_dir.join("rootfs");
        std::fs::create_dir_all(&rootfs_dir).unwrap();

        let layout = test_layout(box_dir);

        let paths = build_path_access(&layout, &[]);

        let rootfs_paths: Vec<_> = paths.iter().filter(|p| p.path == rootfs_dir).collect();
        assert_eq!(rootfs_paths.len(), 1, "Should fallback to home_dir/rootfs/");
        assert!(!rootfs_paths[0].writable);
    }

    #[test]
    fn test_build_path_access_volumes() {
        let dir = tempdir().unwrap();
        let box_dir = dir.path().to_path_buf();
        let layout = test_layout(box_dir);

        // Create volume host paths
        let vol_ro = dir.path().join("input");
        let vol_rw = dir.path().join("output");
        std::fs::create_dir_all(&vol_ro).unwrap();
        std::fs::create_dir_all(&vol_rw).unwrap();

        let volumes = vec![
            VolumeSpec {
                host_path: vol_ro.to_string_lossy().to_string(),
                guest_path: "/mnt/input".to_string(),
                read_only: true,
            },
            VolumeSpec {
                host_path: vol_rw.to_string_lossy().to_string(),
                guest_path: "/mnt/output".to_string(),
                read_only: false,
            },
        ];

        let paths = build_path_access(&layout, &volumes);

        let vol_paths: Vec<_> = paths
            .iter()
            .filter(|p| p.path == vol_ro || p.path == vol_rw)
            .collect();
        assert_eq!(vol_paths.len(), 2, "Both volumes should be listed");

        let ro_vol = vol_paths.iter().find(|p| p.path == vol_ro).unwrap();
        assert!(!ro_vol.writable, "RO volume should be read-only");

        let rw_vol = vol_paths.iter().find(|p| p.path == vol_rw).unwrap();
        assert!(rw_vol.writable, "RW volume should be writable");
    }

    #[test]
    fn test_build_path_access_nonexistent_volume_skipped() {
        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path().to_path_buf());

        let volumes = vec![VolumeSpec {
            host_path: "/does/not/exist".to_string(),
            guest_path: "/mnt/data".to_string(),
            read_only: true,
        }];

        let paths = build_path_access(&layout, &volumes);

        assert!(
            paths.iter().all(|p| p.path != Path::new("/does/not/exist")),
            "Nonexistent volume should be skipped"
        );
    }

    #[test]
    fn test_build_path_access_no_whole_box_dir() {
        let dir = tempdir().unwrap();
        let box_dir = dir.path().to_path_buf();
        let layout = test_layout(box_dir.clone());

        // Create all subdirectories
        std::fs::create_dir_all(layout.sockets_dir()).unwrap();
        std::fs::create_dir_all(layout.mounts_dir()).unwrap();
        std::fs::create_dir_all(layout.logs_dir()).unwrap();
        std::fs::create_dir_all(layout.bin_dir()).unwrap();

        let paths = build_path_access(&layout, &[]);

        // The box_dir itself should NOT appear as a path — only its children
        assert!(
            paths.iter().all(|p| p.path != box_dir),
            "box_dir should not be listed wholesale — only granular paths"
        );
    }

    /// mounts_dir must NOT appear in path access even when it exists on disk.
    /// The shim never writes to mounts/ — host writes before spawn, shim reads via shared_dir.
    #[test]
    fn test_build_path_access_mounts_dir_excluded() {
        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path().to_path_buf());

        // Create mounts_dir AND other dirs that SHOULD appear
        std::fs::create_dir_all(layout.mounts_dir()).unwrap();
        std::fs::create_dir_all(layout.sockets_dir()).unwrap();
        std::fs::create_dir_all(layout.logs_dir()).unwrap();

        let paths = build_path_access(&layout, &[]);

        // mounts_dir must be absent
        assert!(
            paths.iter().all(|p| p.path != layout.mounts_dir()),
            "mounts_dir must NOT appear in path access"
        );

        // sockets_dir should be present (sanity check)
        assert!(
            paths.iter().any(|p| p.path == layout.sockets_dir()),
            "sockets_dir should be present"
        );
    }

    /// shared_dir must appear as read-only — shim reads container images but never modifies them.
    #[test]
    fn test_build_path_access_shared_dir_is_readonly() {
        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path().to_path_buf());

        std::fs::create_dir_all(layout.shared_dir()).unwrap();

        let paths = build_path_access(&layout, &[]);

        let shared = paths.iter().find(|p| p.path == layout.shared_dir());
        assert!(shared.is_some(), "shared_dir should be in path access");
        assert!(!shared.unwrap().writable, "shared_dir must be read-only");
    }

    /// After pre-creating files (as Jailer::command() does), all appear in path access as writable.
    /// console.log lives inside logs/ [RW subpath] — no separate PathAccess entry needed.
    #[test]
    fn test_build_path_access_captures_all_precreated_files() {
        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path().to_path_buf());

        // Simulate pre-create (same as Jailer::command())
        std::fs::create_dir_all(layout.logs_dir()).unwrap();
        std::fs::File::create(layout.exit_file_path()).unwrap();
        std::fs::File::create(layout.console_output_path()).unwrap();

        let paths = build_path_access(&layout, &[]);

        // logs_dir covers both shim logs and console.log
        let logs = paths.iter().find(|p| p.path == layout.logs_dir());
        assert!(logs.is_some(), "logs_dir should be in path access");
        assert!(logs.unwrap().writable, "logs_dir should be writable");

        let exit = paths.iter().find(|p| p.path == layout.exit_file_path());
        assert!(exit.is_some(), "exit_file should be in path access");
        assert!(exit.unwrap().writable, "exit_file should be writable");

        // console.log should NOT have its own PathAccess — covered by logs/ subpath
        let console = paths
            .iter()
            .find(|p| p.path == layout.console_output_path());
        assert!(
            console.is_none(),
            "console.log should not be a standalone path access (covered by logs/)"
        );
    }

    /// End-to-end: builder -> prepare -> command with real tempdir.
    /// Verifies all the pieces (builder, layout, path access, pre-create) work together.
    #[test]
    fn test_jailer_full_flow_with_real_tempdir() {
        use crate::jailer::builder::JailerBuilder;
        use crate::runtime::advanced_options::SecurityOptions;

        let dir = tempdir().unwrap();
        let box_dir = dir.path().to_path_buf();
        let layout = test_layout(box_dir.clone());

        // Create a volume dir
        let vol_dir = dir.path().join("my-volume");
        std::fs::create_dir_all(&vol_dir).unwrap();

        let security = SecurityOptions {
            jailer_enabled: true,
            ..SecurityOptions::default()
        };

        let jail = JailerBuilder::new()
            .with_box_id("e2e-test")
            .with_layout(layout.clone())
            .with_security(security)
            .with_volumes(vec![VolumeSpec {
                host_path: vol_dir.to_string_lossy().to_string(),
                guest_path: "/mnt/data".to_string(),
                read_only: false,
            }])
            .build()
            .unwrap();

        // prepare() should succeed
        jail.prepare().unwrap();

        // command() should not panic and should pre-create files
        let _cmd = jail.command(
            std::path::Path::new("/usr/bin/boxlite-shim"),
            &["--engine".to_string(), "Libkrun".to_string()],
        );

        // Verify pre-create side effects
        assert!(
            layout.logs_dir().exists(),
            "logs_dir should be created by command()"
        );
        assert!(
            layout.exit_file_path().exists(),
            "exit file should be created by command()"
        );
        assert!(
            layout.console_output_path().exists(),
            "console.log should be created by command()"
        );
    }
}
