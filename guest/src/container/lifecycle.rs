//! OCI container lifecycle management
//!
//! Provides container creation, startup, and status checking using libcontainer.
//! Follows the OCI Runtime Specification.

use super::command::ContainerCommand;
use super::spec::UserMount;
use super::stdio::ContainerStdio;
use super::{kill, spec, start};
use crate::layout::GuestLayout;
use crate::service::exec::InitHealthCheck;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use libcontainer::container::Container as LibContainer;
use libcontainer::signal::Signal;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// OCI container
///
/// Manages the lifecycle of an OCI-compliant container using libcontainer.
/// Follows the OCI Runtime Specification.
///
/// # Example
///
/// ```no_run
/// # use guest::container::Container;
/// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
/// // Create and start container
/// let container = Container::start(
///     "my-container",
///     "/rootfs",
///     vec!["sh".to_string()],
///     vec!["PATH=/bin:/usr/bin".to_string()],
///     "/",
/// )?;
///
/// // Execute command
/// let mut child = container.command("ls").args(&["-la"]).spawn().await?;
/// let status = child.wait().await?;
/// # Ok(())
/// # }
/// ```
#[derive(Debug)]
pub struct Container {
    id: String,
    state_root: PathBuf,
    bundle_path: PathBuf,
    env: HashMap<String, String>,
    /// Resolved (uid, gid) from image USER directive, propagated to exec commands.
    user: (u32, u32),
    /// Stdio pipes that keep init process alive.
    /// Dropping this closes pipes → init gets EOF → init exits.
    #[allow(dead_code)]
    stdio: ContainerStdio,
    /// Flag to track if shutdown() was called (prevents double-kill in Drop).
    is_shutdown: std::sync::atomic::AtomicBool,
}

impl Container {
    /// Create and start an OCI container
    ///
    /// Creates a container with the specified rootfs and starts the init process.
    /// The init process runs detached in the background.
    ///
    /// Uses GuestLayout internally to determine paths:
    /// - Container directory: /run/boxlite/{container_id}/
    /// - OCI bundle (config.json): /run/boxlite/{container_id}/config.json
    /// - libcontainer state: /run/boxlite/{container_id}/state.json
    ///
    /// # Arguments
    ///
    /// - `container_id`: Unique container identifier
    /// - `rootfs`: Path to container root filesystem
    /// - `entrypoint`: Command and arguments for container init process
    /// - `env`: Environment variables in "KEY=VALUE" format
    /// - `workdir`: Working directory inside container
    /// - `user_mounts`: Bind mounts from guest VM paths into container
    ///
    /// # Errors
    ///
    /// - Empty rootfs or entrypoint
    /// - Failed to create container directory
    /// - Failed to create or start container
    /// - Init process exited immediately
    pub fn start(
        container_id: &str,
        rootfs: impl AsRef<Path>,
        entrypoint: Vec<String>,
        env: Vec<String>,
        workdir: impl AsRef<Path>,
        user: &str,
        user_mounts: Vec<UserMount>,
    ) -> BoxliteResult<Self> {
        let rootfs = rootfs.as_ref();
        let workdir = workdir.as_ref();

        // Use GuestLayout for all paths (per-container directories)
        let layout = GuestLayout::new();

        // Validate inputs early
        start::validate_container_inputs(rootfs, &entrypoint, workdir)?;

        // Parse existing env into map (KEY=VALUE)
        let mut env_map: HashMap<String, String> = HashMap::new();
        for entry in &env {
            if let Some(pos) = entry.find('=') {
                let key = entry[..pos].to_string();
                let value = entry[pos + 1..].to_string();
                env_map.insert(key, value);
            }
        }

        // State at /run/boxlite/containers/{cid}/state/
        let state_root = layout.container_state_dir(container_id);

        // Resolve user string to numeric (uid, gid) once — used for both
        // init process OCI spec and all subsequent exec commands.
        let rootfs_str = rootfs
            .to_str()
            .ok_or_else(|| BoxliteError::Internal("Invalid rootfs path".to_string()))?;
        let (uid, gid) = spec::resolve_user(rootfs_str, user)?;

        // Create OCI bundle at /run/boxlite/containers/{cid}/
        // create_oci_bundle creates bundle_root/{cid}/, so pass containers_dir
        let bundle_path = start::create_oci_bundle(
            container_id,
            rootfs,
            &entrypoint,
            &env,
            workdir,
            uid,
            gid,
            &layout.containers_dir(),
            &user_mounts,
        )?;

        // Create stdio pipes before container creation.
        // These keep the init process alive by holding stdin open.
        let (stdio, init_fds) = ContainerStdio::new()?;

        // Create and start container with custom stdio
        start::create_container_with_stdio(container_id, &state_root, &bundle_path, init_fds)?;
        start::start_container(container_id, &state_root)?;

        Ok(Self {
            id: container_id.to_string(),
            state_root,
            bundle_path,
            env: env_map,
            user: (uid, gid),
            stdio,
            is_shutdown: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// Check if container init process is running
    ///
    /// Returns `true` if the container is in Running state, `false` otherwise.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # fn example(container: &Container) {
    /// if container.is_running() {
    ///     println!("Container is running");
    /// }
    /// # }
    /// ```
    pub fn is_running(&self) -> bool {
        let container_state_path = self.container_state_path();
        match start::load_container_status(&container_state_path) {
            Ok(status) => {
                use libcontainer::container::ContainerStatus;
                let is_running = matches!(status, ContainerStatus::Running);
                tracing::trace!(
                    container_id = %self.id,
                    status = ?status,
                    is_running = is_running,
                    "Container status check"
                );
                is_running
            }
            Err(e) => {
                tracing::warn!(
                    container_id = %self.id,
                    error = %e,
                    "Failed to load container status, assuming not running"
                );
                false
            }
        }
    }

    /// Get container ID
    ///
    /// Returns the unique container identifier.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # fn example(container: &Container) {
    /// println!("Container ID: {}", container.id());
    /// # }
    /// ```
    #[allow(dead_code)] // API completeness, may be used by future RPC handlers
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Create a command builder for executing processes in this container
    ///
    /// Returns a Command builder. Use `.cmd()` to set the program to execute.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
    /// let mut child = container
    ///     .exec()
    ///     .cmd("ls")
    ///     .args(&["-la", "/tmp"])
    ///     .env("FOO", "bar")
    ///     .spawn()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn cmd(&self) -> ContainerCommand {
        ContainerCommand::new(
            self.id.clone(),
            self.state_root.clone(),
            self.env.clone(),
            self.user,
        )
    }

    /// Drain init process stdout and stderr.
    ///
    /// Reads all available data from the init process pipes using non-blocking I/O.
    /// Can only be called once — subsequent calls return empty strings.
    ///
    /// # Returns
    ///
    /// `(stdout, stderr)` — captured output from the init process.
    pub fn drain_init_output(&mut self) -> (String, String) {
        self.stdio.drain_output()
    }

    /// Diagnose why container is not running
    ///
    /// Provides detailed information for debugging container startup failures.
    /// Gathers container state, process information, and common failure indicators.
    ///
    /// # Returns
    ///
    /// A diagnostic message with container ID, status, PID, and process state.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # fn example(container: &Container) {
    /// if !container.is_running() {
    ///     let diagnostics = container.diagnose_exit();
    ///     eprintln!("Container failed: {}", diagnostics);
    /// }
    /// # }
    /// ```
    pub fn diagnose_exit(&mut self) -> String {
        let container_state_path = self.container_state_path();

        // Drain init process output before building diagnostics
        let (init_stdout, init_stderr) = self.drain_init_output();

        // Try to load container state from libcontainer
        let mut result = match LibContainer::load(container_state_path.clone()) {
            Ok(libcontainer) => {
                let status = libcontainer.status();
                let pid = libcontainer.pid();

                let mut diagnostics = vec![
                    format!("Container ID: {}", self.id),
                    format!("Status: {:?}", status),
                ];

                if let Some(pid) = pid {
                    diagnostics.push(format!("PID: {}", pid));

                    // Try to get process state information
                    #[cfg(target_os = "linux")]
                    {
                        if let Ok(proc) = procfs::process::Process::new(pid.as_raw()) {
                            if let Ok(stat) = proc.stat() {
                                if let Ok(state) = stat.state() {
                                    diagnostics.push(format!("Process state: {:?}", state));
                                }
                            }
                        } else {
                            diagnostics.push("Process: no longer exists (exited)".to_string());
                        }
                    }
                } else {
                    diagnostics.push(
                        "PID: none (init process never started or exited immediately)".to_string(),
                    );
                }

                // Check for common issues
                if !self.bundle_path.exists() {
                    diagnostics.push(format!(
                        "Bundle path missing: {}",
                        self.bundle_path.display()
                    ));
                }

                diagnostics.join(", ")
            }
            Err(e) => {
                format!(
                    "Container ID: {}, Failed to load container state from {}: {}",
                    self.id,
                    container_state_path.display(),
                    e
                )
            }
        };

        // Append captured init output if any
        if !init_stdout.is_empty() {
            result.push_str(&format!(", Init stdout: {}", init_stdout.trim()));
        }
        if !init_stderr.is_empty() {
            result.push_str(&format!(", Init stderr: {}", init_stderr.trim()));
        }

        result
    }

    /// Gracefully shutdown the container.
    ///
    /// Sends SIGTERM first, waits for exit with timeout, then SIGKILL if needed.
    /// Sets the `shutdown_called` flag to prevent double-kill in Drop.
    ///
    /// # Arguments
    ///
    /// - `timeout_ms`: Maximum time to wait for graceful exit before SIGKILL
    ///
    /// # Returns
    ///
    /// Ok(()) on successful shutdown, or if container was already stopped.
    pub fn shutdown(&self, timeout_ms: u64) -> BoxliteResult<()> {
        self.is_shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);

        let container_state_path = self.container_state_path();
        let mut container = match LibContainer::load(container_state_path) {
            Ok(c) => c,
            Err(_) => {
                tracing::debug!(container_id = %self.id, "Container already gone, nothing to shutdown");
                return Ok(());
            }
        };

        if !container.can_kill() {
            tracing::debug!(container_id = %self.id, "Container cannot be killed, skipping shutdown");
            return Ok(());
        }

        // Step 1: Send SIGTERM
        tracing::info!(container_id = %self.id, "Sending SIGTERM to container");
        let sigterm = Signal::try_from(15).expect("SIGTERM (15) is a valid signal");
        let _ = container.kill(sigterm, true);

        // Step 2: Wait for graceful exit with timeout
        let start = std::time::Instant::now();
        while start.elapsed().as_millis() < timeout_ms as u128 {
            if !self.is_running() {
                tracing::info!(container_id = %self.id, "Container exited gracefully");
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Step 3: SIGKILL if still running
        tracing::warn!(container_id = %self.id, "Container didn't exit gracefully, sending SIGKILL");
        let sigkill = Signal::try_from(9).expect("SIGKILL (9) is a valid signal");
        let _ = container.kill(sigkill, true);

        Ok(())
    }

    fn container_state_path(&self) -> PathBuf {
        self.state_root.join(&self.id)
    }
}

// ====================
// Init Health Check
// ====================

impl InitHealthCheck for Container {
    fn is_running(&self) -> bool {
        self.is_running()
    }

    fn diagnose_exit(&mut self) -> String {
        self.diagnose_exit()
    }
}

// ====================
// Cleanup
// ====================

impl Drop for Container {
    fn drop(&mut self) {
        tracing::debug!(container_id = %self.id, "Cleaning up container");

        let container_state_path = self.container_state_path();

        if let Ok(mut container) = LibContainer::load(container_state_path) {
            // Skip kill if already shutdown gracefully
            if self.is_shutdown.load(std::sync::atomic::Ordering::SeqCst) {
                tracing::debug!(container_id = %self.id, "Container already shutdown, skipping kill");
            } else {
                // Fallback: SIGKILL if shutdown() wasn't called
                kill::kill_container(&mut container);
            }
            kill::delete_container(&mut container);
        }

        start::cleanup_bundle_directory(&self.bundle_path);

        tracing::debug!(container_id = %self.id, "Container cleanup complete");
    }
}
