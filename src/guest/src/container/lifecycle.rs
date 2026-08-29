//! OCI container lifecycle management
//!
//! Provides container creation, startup, and status checking using libcontainer.
//! Follows the OCI Runtime Specification.

use super::capabilities::CapabilitySet;
use super::command::ContainerCommand;
use super::spec::{ContainerDevices, MountOverride, UserMount};
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
    modes: Vec::new(),
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
    /// Destinations of every mount the applied OCI spec declares.
    mount_destinations: Vec<PathBuf>,
    /// Resolved capability set shared by init and every exec process.
    capabilities: CapabilitySet,
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
    /// - `capabilities`/`readonly_paths`/`mount_override`: security fields
    ///   resolved at the RPC boundary
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
        capabilities: CapabilitySet,
        readonly_paths: Vec<String>,
        mount_override: MountOverride,
        devices: ContainerDevices,
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
        let bundle = start::create_oci_bundle(
            container_id,
            rootfs,
            &entrypoint,
            &env,
            workdir,
            uid,
            gid,
            &capabilities,
            &readonly_paths,
            &mount_override,
            &layout.containers_dir(),
            &user_mounts,
            tty,
            &devices,
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
                &bundle.path,
                start::InitIoSetup::Console(socket.path().to_string()),
            )?;
            ContainerStdio::pty(socket.receive_pty_master()?)
        } else {
            // Pipes exist before the container does. The guest holds stdin's
            // write-end, so init's read() blocks instead of seeing EOF.
            let (stdio, init_fds) = ContainerStdio::pipes()?;
            start::create_container_with_stdio(
                container_id,
                &state_root,
                &bundle.path,
                start::InitIoSetup::Pipes(init_fds),
            )?;
            stdio
        };

        // Note: init is *created*, not started. `run_init()` does that, so a
        // caller can attach to the main command before it runs.

        Ok(Self {
            id: container_id.to_string(),
            state_root,
            bundle_path: bundle.path,
            env: env_map,
            user: (uid, gid),
            mount_destinations: bundle.mount_destinations,
            capabilities,
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
    ///
    /// Idempotent: a container whose init is already up no-ops here instead of
    /// reaching youki's start, which errors with IncorrectStatus on a Running
    /// container. This method itself takes no lock — the guarantee relies on
    /// both callers (the Container.Start RPC and the exec zombie-revival path)
    /// holding the per-container mutex, so concurrent calls serialize at the
    /// caller and the late one observes Running. A Created container (the
    /// zombie, or a start still in flight behind the lock) proceeds to start.
    pub fn run_init(&self) -> BoxliteResult<()> {
        if self.is_running() {
            return Ok(());
        }
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

    /// The (uid, gid) every process in this container runs as.
    ///
    /// Resolved once at creation from the image's `USER` directive (or the
    /// box-level override) and handed to init and every exec alike, so anything
    /// that wants to match what the workload can read should ask here rather
    /// than guessing.
    pub fn user(&self) -> (u32, u32) {
        self.user
    }

    /// Destinations of every mount the container was created with.
    ///
    /// Taken from the OCI spec that was actually applied — the same object
    /// `config.json` was written from — so it covers the standard tmpfs/pseudo
    /// mounts and user volumes alike and cannot drift from what the runtime
    /// did. Callers use this to tell whether a path inside the container is
    /// reachable through the rootfs directory: anything at or below one of
    /// these destinations is covered by a mount in the container's own
    /// namespace and is *not* the file a process in the box would see at that
    /// path.
    ///
    /// Resolved once at creation, like [`Self::user`], rather than re-read per
    /// question: the bundle is written once and never rewritten, and the
    /// callers are RPC handlers on the guest's async runtime — which on a
    /// single-vCPU box is a single worker thread — so a `Spec::load` here
    /// stalled every other in-flight RPC for the length of a file read and a
    /// deserialize.
    pub fn mount_destinations(&self) -> &[PathBuf] {
        &self.mount_destinations
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

    /// Test-only constructor: a container whose libcontainer state must be
    /// written separately by the test (see `run_init_is_noop_when_init_already_running`
    /// and the exec `failed_spawn_on_a_running_container_is_not_retried` test,
    /// which save a Running state file first). `is_shutdown` is set so Drop
    /// never signals the recorded pid — tests point it at their own process.
    #[cfg(test)]
    pub(crate) fn for_unit_test(id: &str, state_root: PathBuf, bundle_path: PathBuf) -> Self {
        // Drop removes the bundle directory; create it so cleanup is a
        // silent no-op instead of warning on a NotFound during tests.
        std::fs::create_dir_all(&bundle_path).expect("create bundle dir for unit test");
        Self {
            id: id.to_string(),
            state_root,
            bundle_path,
            env: HashMap::new(),
            user: (0, 0),
            mount_destinations: Vec::new(),
            capabilities: CapabilitySet::default(),
            stdio: ContainerStdio::pipes().expect("create stdio pipes").0,
            is_shutdown: std::sync::atomic::AtomicBool::new(true),
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
            } => init_pipe_handle(pid, stdin, stdout, stderr)?,
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
            self.capabilities.clone(),
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

fn init_pipe_handle(
    pid: nix::unistd::Pid,
    stdin: std::os::fd::OwnedFd,
    stdout: std::os::fd::OwnedFd,
    stderr: std::os::fd::OwnedFd,
) -> BoxliteResult<ExecHandle> {
    match ExecHandle::new(pid, stdin, stdout, Some(stderr)) {
        Ok(handle) => Ok(handle),
        Err(error) => {
            super::command::terminate_process(pid);
            Err(error)
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use libcontainer::container::{ContainerStatus, State};
    use nix::sys::signal::kill;
    use nix::unistd::{pipe, Pid};
    use std::os::fd::OwnedFd;
    use std::process::{Child, Command};

    struct ChildGuard(Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn init_pipe_handle_failure_reaps_init() {
        let child = ChildGuard(
            Command::new("/bin/sh")
                .args(["-c", "sleep 30"])
                .spawn()
                .unwrap(),
        );
        let pid = Pid::from_raw(child.0.id() as i32);
        let (_stdin_read, stdin_write) = pipe().unwrap();
        let stdout: OwnedFd = std::fs::File::open("/proc/self/stat").unwrap().into();
        let (stderr_read, _stderr_write) = pipe().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .unwrap();

        let result =
            runtime.block_on(async { init_pipe_handle(pid, stdin_write, stdout, stderr_read) });

        assert!(
            result.is_err(),
            "regular files cannot register with AsyncFd"
        );
        assert!(
            kill(pid, None).is_err(),
            "failed init handle must not leave a child"
        );
    }

    /// `run_init` must be idempotent: the Container.Start RPC and the exec
    /// zombie-revival path both call it, and a second call on a container whose
    /// init is already running must no-op — youki's `start()` errors with
    /// `IncorrectStatus(Running)` on a Running container, and that error is the
    /// failure this test exists to pin.
    #[test]
    fn run_init_is_noop_when_init_already_running() {
        // `container_state_path()` is `state_root.join(id)`, and libcontainer
        // persists the state as `<that dir>/state.json` — so point the two
        // halves at one TempDir by splitting it into parent + name.
        let dir = tempfile::TempDir::new().expect("create temp dir");
        let state_root = dir
            .path()
            .parent()
            .expect("temp dir has a parent")
            .to_path_buf();
        let id = dir
            .path()
            .file_name()
            .expect("temp dir has a name")
            .to_string_lossy()
            .to_string();

        // Running with our own (alive) pid: `refresh_status` keeps it Running,
        // the same trick `load_container_status_refreshes_stale_persisted_status`
        // relies on in start.rs.
        let state = State::new(
            &id,
            ContainerStatus::Running,
            Some(i32::try_from(std::process::id()).expect("current pid fits in i32")),
            dir.path().to_path_buf(),
        );
        state.save(dir.path()).expect("save libcontainer state");

        // Drop removes the bundle directory; create it so cleanup is a
        // silent no-op instead of warning on a NotFound during tests.
        std::fs::create_dir_all(dir.path().join("bundle")).expect("create bundle dir");
        let container = Container {
            id,
            state_root,
            bundle_path: dir.path().join("bundle"),
            env: HashMap::new(),
            user: (0, 0),
            mount_destinations: Vec::new(),
            capabilities: CapabilitySet::default(),
            stdio: ContainerStdio::pipes().expect("create stdio pipes").0,
            // Drop must not SIGKILL the recorded pid — it is this test process.
            is_shutdown: std::sync::atomic::AtomicBool::new(true),
        };

        let result = container.run_init();
        assert!(
            result.is_ok(),
            "run_init on an already-running container must no-op, got: {result:?}"
        );
    }
}
