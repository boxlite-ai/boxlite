//! Subprocess spawning for boxlite-shim binary.

use std::{
    path::{Path, PathBuf},
    process::{Child, Stdio},
};

use crate::jailer::{Jail, JailerBuilder};
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::BoxOptions;
use crate::util::configure_library_env_with_prepend;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::watchdog;

/// A shim that was spawned, with its child process handle and optional keepalive.
///
/// The `keepalive` holds the parent side of the watchdog pipe. While it exists,
/// the shim's watchdog thread blocks on `poll()`. Dropping it closes the pipe
/// write end, delivering POLLHUP to the shim and triggering graceful shutdown.
pub struct SpawnedShim {
    pub child: Child,
    /// Parent-side watchdog keepalive. Dropping triggers shim shutdown.
    /// `None` for detached boxes (no watchdog).
    pub keepalive: Option<watchdog::Keepalive>,
}

/// Spawns `boxlite-shim` with full isolation, environment, and watchdog.
///
/// Composes: Jailer (isolation) + watchdog (lifecycle) + env/stdio setup.
///
/// # Fields
///
/// Stable inputs grouped into the struct; variable inputs (`config_json`, `detach`)
/// are passed to [`spawn()`](Self::spawn).
pub struct ShimSpawner<'a> {
    binary_path: &'a Path,
    layout: &'a BoxFilesystemLayout,
    box_id: &'a str,
    options: &'a BoxOptions,
}

impl<'a> ShimSpawner<'a> {
    pub fn new(
        binary_path: &'a Path,
        layout: &'a BoxFilesystemLayout,
        box_id: &'a str,
        options: &'a BoxOptions,
    ) -> Self {
        Self {
            binary_path,
            layout,
            box_id,
            options,
        }
    }

    /// Spawn the shim subprocess with jailer isolation and optional watchdog.
    ///
    /// When `detach` is false, creates a watchdog pipe so the shim detects
    /// parent death via POLLHUP. When `detach` is true, no watchdog is created.
    ///
    /// # Returns
    /// * `SpawnedShim` containing the child process and optional keepalive
    pub fn spawn(&self, config_json: &str, detach: bool) -> BoxliteResult<SpawnedShim> {
        // 1. Create watchdog pipe (non-detached only)
        let (keepalive, child_setup) = if !detach {
            let (k, s) = watchdog::create()?;
            (Some(k), Some(s))
        } else {
            (None, None)
        };

        // 2. Build jailer with optional FD preservation for watchdog pipe
        let mut builder = JailerBuilder::new()
            .with_box_id(self.box_id)
            .with_layout(self.layout.clone())
            .with_security(self.options.advanced.security.clone())
            .with_volumes(self.options.volumes.clone());

        if let Some(ref setup) = child_setup {
            builder = builder.with_preserved_fd(setup.raw_fd(), watchdog::PIPE_FD);
        }

        let jail = builder.build()?;

        // 3. Setup pre-spawn isolation (cgroups on Linux, no-op on macOS)
        jail.prepare()?;

        // 4. Build isolated command — no CLI args, config sent via stdin pipe
        let no_args: &[String] = &[];
        let mut cmd = jail.command(self.binary_path, no_args);

        // 5. Configure environment
        self.configure_env(&mut cmd);

        // 6. Configure stdio
        // stdin=piped: config JSON is sent via stdin to avoid /proc/cmdline exposure
        // (config contains CA private keys and secret values)
        let stderr_file = self.create_stderr_file()?;
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::from(stderr_file));

        // 7. Spawn
        let mut child = cmd.spawn().map_err(|e| {
            let err_msg = format!(
                "Failed to spawn VM subprocess at {}: {}",
                self.binary_path.display(),
                e
            );
            tracing::error!("{}", err_msg);
            BoxliteError::Engine(err_msg)
        })?;

        // 8. Write config to stdin, then close (shim reads until EOF).
        // The child is already spawned and will read from stdin, so this is a
        // producer-consumer pattern via the kernel pipe buffer. For typical
        // configs (~2-5KB), write_all completes immediately. For large configs
        // (>16KB on macOS, >64KB on Linux), write_all blocks until the child
        // drains the buffer — which it does as its first action in main().
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            stdin.write_all(config_json.as_bytes()).map_err(|e| {
                BoxliteError::Engine(format!("Failed to write config to shim stdin: {e}"))
            })?;
            drop(stdin); // close write end — shim sees EOF
        }

        // 9. Close read end in parent (child inherited it via fork)
        drop(child_setup);

        Ok(SpawnedShim { child, keepalive })
    }

    fn configure_env(&self, cmd: &mut std::process::Command) {
        // Pass debugging environment variables to subprocess
        if let Ok(rust_log) = std::env::var("RUST_LOG") {
            cmd.env("RUST_LOG", rust_log);
        }
        if let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE") {
            cmd.env("RUST_BACKTRACE", rust_backtrace);
        }

        // Keep temp artifacts inside the box-scoped allowlist when using the
        // built-in macOS seatbelt profile. libkrun may create a transient
        // `krun-empty-root-*` under `env::temp_dir()` when booting from block
        // devices; under deny-default seatbelt this must resolve to an
        // explicitly granted path.
        if self.options.advanced.security.jailer_enabled
            && self.options.advanced.security.sandbox_profile.is_none()
        {
            let tmp_dir = self.layout.tmp_dir();
            cmd.env("TMPDIR", &tmp_dir);
            cmd.env("TMP", &tmp_dir);
            cmd.env("TEMP", &tmp_dir);
        }

        // For `--privileged` boxes, stage a per-box libs dir whose
        // libkrunfw.so.5 symlinks to the fat (dind-capable) blob in the
        // embedded runtime. Prepending this dir to LD_LIBRARY_PATH makes
        // libkrun's dlopen pick the fat kernel for THIS box only, without
        // touching the symlink other (lean-profile) boxes load.
        //
        // Failure modes fall back to lean with a warning rather than
        // aborting the box: a user with --privileged but no dind blob
        // built still gets the Phase-A caps + cgroup-rw — they just won't
        // see bridge networks / iptables work. That degradation is OK and
        // matches the existing behaviour before the dind blob was wired.
        let dind_libs = if self.options.privileged {
            self.stage_dind_libkrunfw().unwrap_or_else(|e| {
                tracing::warn!(
                    box_id = %self.box_id,
                    error = %e,
                    "Failed to stage dind libkrunfw — falling back to lean kernel. \
                     Caps + cgroup-rw still apply, but bridge networks won't work. \
                     Run `make libkrunfw-dind` and rebuild boxlite with \
                     BOXLITE_LIBKRUNFW_DIND_PATH set."
                );
                None
            })
        } else {
            None
        };

        // Set library search paths for bundled dependencies (e.g., libkrunfw.so)
        let prepend: Vec<PathBuf> = dind_libs.into_iter().collect();
        configure_library_env_with_prepend(cmd, std::ptr::null(), &prepend);
    }

    /// Create `<box_dir>/libs/libkrunfw.so.5` as a symlink to the fat
    /// libkrunfw blob shipped alongside the lean one. Returns the libs
    /// dir if the fat blob was staged at build time; returns `Ok(None)`
    /// when the embedded runtime has no `libkrunfw-dind.so.5` (the
    /// expected case unless someone ran `make libkrunfw-dind` + rebuilt
    /// boxlite with BOXLITE_LIBKRUNFW_DIND_PATH set).
    ///
    /// The symlink is per-box and lives under the box's working
    /// directory, so it's torn down whenever boxlite cleans up the box
    /// — no shared state to garbage-collect.
    fn stage_dind_libkrunfw(&self) -> BoxliteResult<Option<PathBuf>> {
        #[cfg(feature = "embedded-runtime")]
        let runtime_dir = crate::runtime::embedded::EmbeddedRuntime::get()
            .ok_or_else(|| BoxliteError::Engine("embedded runtime unavailable".to_string()))?
            .dir()
            .to_path_buf();
        #[cfg(not(feature = "embedded-runtime"))]
        let runtime_dir: PathBuf = return Ok(None);

        let dind_blob = runtime_dir.join("libkrunfw-dind.so.5");
        if !dind_blob.exists() {
            return Ok(None);
        }

        // Per-box libs dir lives next to the rest of the box's runtime
        // state under root(). The symlink is wiped together with the box
        // on `boxlite rm` — no shared state to garbage-collect.
        let libs_dir = self.layout.root().join("libs");
        std::fs::create_dir_all(&libs_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create dind libs dir {}: {}",
                libs_dir.display(),
                e
            ))
        })?;

        let symlink_path = libs_dir.join("libkrunfw.so.5");
        // Idempotent: a stale symlink from a prior spawn (e.g. crash + restart)
        // would otherwise cause symlink() to fail with EEXIST. Symlink only,
        // never a regular file — if a regular file is sitting at this path,
        // something else has put it there and we should NOT silently delete.
        match std::fs::symlink_metadata(&symlink_path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                std::fs::remove_file(&symlink_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to remove stale dind symlink {}: {}",
                        symlink_path.display(),
                        e
                    ))
                })?;
            }
            Ok(_) => {
                return Err(BoxliteError::Storage(format!(
                    "Refusing to overwrite non-symlink at {}",
                    symlink_path.display()
                )));
            }
            Err(_) => {}
        }

        #[cfg(unix)]
        std::os::unix::fs::symlink(&dind_blob, &symlink_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to symlink {} → {}: {}",
                symlink_path.display(),
                dind_blob.display(),
                e
            ))
        })?;

        tracing::info!(
            box_id = %self.box_id,
            dind_blob = %dind_blob.display(),
            libs_dir = %libs_dir.display(),
            "Staged dind libkrunfw symlink for --privileged box"
        );
        Ok(Some(libs_dir))
    }

    fn create_stderr_file(&self) -> BoxliteResult<std::fs::File> {
        // Create stderr file BEFORE spawn to capture ALL errors including pre-main dyld errors.
        // This is critical: dyld errors happen before main() and would go to /dev/null otherwise.
        let stderr_file_path = self.layout.stderr_file_path();
        std::fs::File::create(&stderr_file_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create stderr file {}: {}",
                stderr_file_path.display(),
                e
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn test_build_shim_args() {
        use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
        use std::path::PathBuf;

        let layout = BoxFilesystemLayout::new(
            PathBuf::from("/tmp/box"),
            FsLayoutConfig::without_bind_mount(),
            false,
        );
        let options = BoxOptions::default();

        let spawner = ShimSpawner::new(
            Path::new("/usr/bin/boxlite-shim"),
            &layout,
            "test-box",
            &options,
        );

        // No CLI args — config is sent via stdin pipe
        // Just verify the spawner was created without error
        assert_eq!(spawner.box_id, "test-box");
    }

    #[test]
    fn test_configure_env_sets_box_scoped_temp_dir() {
        use crate::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};
        use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
        use std::path::PathBuf;

        let layout = BoxFilesystemLayout::new(
            PathBuf::from("/tmp/box"),
            FsLayoutConfig::without_bind_mount(),
            false,
        );
        let options = BoxOptions {
            advanced: AdvancedBoxOptions {
                security: SecurityOptions {
                    jailer_enabled: true,
                    ..SecurityOptions::default()
                },
                ..AdvancedBoxOptions::default()
            },
            ..BoxOptions::default()
        };

        let spawner = ShimSpawner::new(
            Path::new("/usr/bin/boxlite-shim"),
            &layout,
            "test-box",
            &options,
        );

        let mut cmd = std::process::Command::new("/usr/bin/true");
        spawner.configure_env(&mut cmd);

        let envs: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        let expected = layout.tmp_dir();

        assert_eq!(
            envs.get(OsStr::new("TMPDIR")).and_then(|v| *v),
            Some(expected.as_os_str())
        );
        assert_eq!(
            envs.get(OsStr::new("TMP")).and_then(|v| *v),
            Some(expected.as_os_str())
        );
        assert_eq!(
            envs.get(OsStr::new("TEMP")).and_then(|v| *v),
            Some(expected.as_os_str())
        );
    }

    #[test]
    fn test_configure_env_does_not_override_temp_for_custom_profile() {
        use crate::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};
        use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
        use std::path::PathBuf;

        let layout = BoxFilesystemLayout::new(
            PathBuf::from("/tmp/box"),
            FsLayoutConfig::without_bind_mount(),
            false,
        );
        let options = BoxOptions {
            advanced: AdvancedBoxOptions {
                security: SecurityOptions {
                    jailer_enabled: true,
                    sandbox_profile: Some(PathBuf::from("/tmp/custom.sbpl")),
                    ..SecurityOptions::default()
                },
                ..AdvancedBoxOptions::default()
            },
            ..BoxOptions::default()
        };

        let spawner = ShimSpawner::new(
            Path::new("/usr/bin/boxlite-shim"),
            &layout,
            "test-box",
            &options,
        );

        let mut cmd = std::process::Command::new("/usr/bin/true");
        spawner.configure_env(&mut cmd);

        let envs: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        assert!(!envs.contains_key(OsStr::new("TMPDIR")));
        assert!(!envs.contains_key(OsStr::new("TMP")));
        assert!(!envs.contains_key(OsStr::new("TEMP")));
    }
}
