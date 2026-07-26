//! OCI container lifecycle management
//!
//! Provides container creation, startup, and status checking using libcontainer.
//! Follows the OCI Runtime Specification.

use super::command::ContainerCommand;
use super::spec::UserMount;
use super::stdio::{ContainerStdio, InitIo};
use super::{console_socket, kill, spec, start};
use crate::layout::GuestLayout;
use crate::service::exec::exec_handle::{ExecHandle, PtyConfig};
use crate::service::exec::InitHealthCheck;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use libcontainer::container::Container as LibContainer;
use libcontainer::signal::Signal;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Size init's PTY opens at.
///
/// Deliberately not configurable at create time: a box outlives the clients
/// that attach to it, so a size captured then would describe a terminal that no
/// longer exists. The attaching client's `ResizeTty` sets the real size, and
/// until one attaches nothing is rendering anyway. 80x24 is the VT100 default
/// every terminal falls back to.
const DEFAULT_INIT_PTY: PtyConfig = PtyConfig {
    rows: 24,
    cols: 80,
    x_pixels: 0,
    y_pixels: 0,
};

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
/// let child = container.command("ls").args(&["-la"]).spawn().await?;
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
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        container_id: &str,
        rootfs: impl AsRef<Path>,
        entrypoint: Vec<String>,
        env: Vec<String>,
        workdir: impl AsRef<Path>,
        user: &str,
        user_mounts: Vec<UserMount>,
        tty: bool,
        log_capture: Option<PathBuf>,
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

        // Auto-idmap: remap volume UIDs when host owner differs from container user.
        // Uses a full-range swap mapping so all UIDs remain valid (no overflow).
        for mount in &user_mounts {
            if mount.read_only || mount.owner_uid == uid {
                continue;
            }
            let uid_mappings =
                crate::storage::idmap::build_swap_mapping(mount.owner_uid, uid, 65536);
            let gid_mappings =
                crate::storage::idmap::build_swap_mapping(mount.owner_gid, gid, 65536);

            let mount_path = std::path::Path::new(&mount.source);
            match crate::storage::idmap::remap_mount(mount_path, &uid_mappings, &gid_mappings) {
                Ok(true) => tracing::info!(
                    "Auto-idmap: {}:{} → {}:{} on {}",
                    mount.owner_uid,
                    mount.owner_gid,
                    uid,
                    gid,
                    mount.source
                ),
                Ok(false) => {
                    tracing::debug!("Auto-idmap not supported for {}, skipping", mount.source)
                }
                Err(e) => tracing::warn!(
                    "Auto-idmap failed for {}: {}, continuing without",
                    mount.source,
                    e
                ),
            }
        }

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
            tty,
        )?;

        let stdio = if tty {
            // libcontainer allocates the PTY while creating init and passes the
            // master back over this socket, so the socket must exist before the
            // build and be read after it — a PTY, unlike a pipe, cannot be made
            // before the process that owns the other end.
            let socket = console_socket::ConsoleSocket::new(container_id)?;
            start::create_container_with_stdio(
                container_id,
                &state_root,
                &bundle_path,
                start::InitIoSetup::Console(socket.path().to_string()),
            )?;
            ContainerStdio::pty(socket.receive_pty_master()?)
        } else {
            // Pipes exist before the container does. The guest holds stdin's
            // write-end, so init's read() blocks instead of seeing EOF.
            let (mut stdio, init_fds) = ContainerStdio::pipes()?;
            stdio.start_output_pump(log_capture)?;
            start::create_container_with_stdio(
                container_id,
                &state_root,
                &bundle_path,
                start::InitIoSetup::Pipes(init_fds),
            )?;
            stdio
        };

        // Note: init is *created*, not started. `run_init()` does that, so a
        // caller can attach to the main command before it runs.

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

    /// Run the init process of a container that was created but not started.
    ///
    /// Separated from creation so the host can attach to the main command first
    /// — docker's create → attach → start. Fused, a command that finishes
    /// immediately can be gone before an attach issued after start reaches the
    /// guest, taking its output and exit code with it when the VM powers off.
    pub fn run_init(&self) -> BoxliteResult<()> {
        start::start_container(&self.id, &self.state_root)
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

    /// PID of the container's init process, from libcontainer state.
    ///
    /// `None` if the state can't be loaded or init never started.
    pub fn init_pid(&self) -> Option<nix::unistd::Pid> {
        let container_state_path = self.container_state_path();
        match LibContainer::load(container_state_path) {
            Ok(libcontainer) => libcontainer.pid(),
            Err(e) => {
                tracing::warn!(
                    container_id = %self.id,
                    error = %e,
                    "Failed to load container state for init pid"
                );
                None
            }
        }
    }

    /// Build the exec-session handle for the container's init process — the
    /// session the host attaches to as the box's *main command*.
    ///
    /// Whether init sits on pipes or a PTY is decided at container creation and
    /// is nobody else's business, so it is resolved here rather than leaking a
    /// tuple of fds and a terminal flag to the service layer.
    ///
    /// Returns `None` if init has no pid (it is gone) or its stdio was already
    /// taken. Callable once.
    pub fn take_init_exec_handle(&mut self) -> BoxliteResult<Option<ExecHandle>> {
        let Some(pid) = self.init_pid() else {
            return Ok(None);
        };
        let Some(io) = self.stdio.take_init_io()? else {
            return Ok(None);
        };

        let handle = match io {
            InitIo::Pipes {
                stdin,
                stdout,
                stderr,
            } => ExecHandle::new(pid, stdin, stdout, Some(stderr)),
            // Mirrors the tenant PTY path: the master becomes stdin+stdout and
            // is retained for window-size ioctls, so ResizeTty reaches the main
            // command exactly as it reaches an exec.
            InitIo::Pty { master } => {
                super::command::create_pty_child(pid, master, DEFAULT_INIT_PTY)?
            }
        };
        Ok(Some(handle))
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
            self.bundle_path.join("rootfs"),
        )
    }

    /// Take the bounded diagnostic tails for init stdout and stderr.
    ///
    /// The always-on output pump owns the pipes and retains the latest bytes
    /// per stream. Taking the tails clears them; subsequent calls are empty.
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

        // Take the bounded init output tails before building diagnostics
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
    pub async fn shutdown(&mut self, timeout_ms: u64) -> BoxliteResult<()> {
        const LOG_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
        self.is_shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);

        let container_state_path = self.container_state_path();
        let mut container = match LibContainer::load(container_state_path) {
            Ok(c) => c,
            Err(_) => {
                tracing::debug!(container_id = %self.id, "Container already gone, nothing to shutdown");
                self.stdio.finish_output(LOG_DRAIN_TIMEOUT).await;
                return Ok(());
            }
        };

        if !container.can_kill() {
            tracing::debug!(container_id = %self.id, "Container cannot be killed, skipping shutdown");
            self.stdio.finish_output(LOG_DRAIN_TIMEOUT).await;
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
                self.stdio.finish_output(LOG_DRAIN_TIMEOUT).await;
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        // Step 3: SIGKILL if still running
        tracing::warn!(container_id = %self.id, "Container didn't exit gracefully, sending SIGKILL");
        let sigkill = Signal::try_from(9).expect("SIGKILL (9) is a valid signal");
        let _ = container.kill(sigkill, true);

        self.stdio.finish_output(LOG_DRAIN_TIMEOUT).await;
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
