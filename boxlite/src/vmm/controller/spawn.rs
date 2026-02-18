//! Subprocess spawning for boxlite-shim binary.

use std::{
    path::Path,
    process::{Child, Stdio},
};

use crate::jailer::{Jail, JailerBuilder};
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::BoxOptions;
use crate::util::configure_library_env;
use crate::vmm::VmmKind;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use libkrun_sys::krun_create_ctx;

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
    engine_type: VmmKind,
    layout: &'a BoxFilesystemLayout,
    box_id: &'a str,
    options: &'a BoxOptions,
}

impl<'a> ShimSpawner<'a> {
    pub fn new(
        binary_path: &'a Path,
        engine_type: VmmKind,
        layout: &'a BoxFilesystemLayout,
        box_id: &'a str,
        options: &'a BoxOptions,
    ) -> Self {
        Self {
            binary_path,
            engine_type,
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

        // 4. Build isolated command (includes pre_exec hook)
        let shim_args = self.build_shim_args(config_json);
        let mut cmd = jail.command(self.binary_path, &shim_args);

        // 5. Configure environment
        self.configure_env(&mut cmd);

        // 6. Configure stdio (stdin/stdout=null, stderr=file)
        let stderr_file = self.create_stderr_file()?;
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::from(stderr_file));

        // 7. Spawn
        let child = cmd.spawn().map_err(|e| {
            let err_msg = format!(
                "Failed to spawn VM subprocess at {}: {}",
                self.binary_path.display(),
                e
            );
            tracing::error!("{}", err_msg);
            BoxliteError::Engine(err_msg)
        })?;

        // 8. Close read end in parent (child inherited it via fork)
        drop(child_setup);

        Ok(SpawnedShim { child, keepalive })
    }

    fn build_shim_args(&self, config_json: &str) -> Vec<String> {
        vec![
            "--engine".to_string(),
            format!("{:?}", self.engine_type),
            "--config".to_string(),
            config_json.to_string(),
        ]
    }

    fn configure_env(&self, cmd: &mut std::process::Command) {
        // Pass debugging environment variables to subprocess
        if let Ok(rust_log) = std::env::var("RUST_LOG") {
            cmd.env("RUST_LOG", rust_log);
        }
        if let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE") {
            cmd.env("RUST_BACKTRACE", rust_backtrace);
        }

        // Set library search paths for bundled dependencies
        configure_library_env(cmd, krun_create_ctx as *const libc::c_void);
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
            VmmKind::Libkrun,
            &layout,
            "test-box",
            &options,
        );

        let args = spawner.build_shim_args("{\"test\":true}");
        assert_eq!(args.len(), 4);
        assert_eq!(args[0], "--engine");
        assert_eq!(args[1], "Libkrun");
        assert_eq!(args[2], "--config");
        assert_eq!(args[3], "{\"test\":true}");
    }
}
