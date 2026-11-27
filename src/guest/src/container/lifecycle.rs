//! Container lifecycle management
//!
//! The zygote owns process lifecycle state; this handle owns the guest-side I/O.

use super::capabilities::CapabilitySet;
use super::command::ContainerCommand;
use super::spec::{ContainerCgroup, ContainerDevices, MountOverride, UserMount};
use super::stdio::{ContainerStdio, InitIo};
use super::zygote::{InitBuildSpec, Status, ZYGOTE};
use super::{spec, start};
use crate::layout::GuestLayout;
use crate::service::exec::exec_handle::{ExecHandle, PtyConfig};
use crate::service::exec::InitHealthCheck;
use crate::storage::attach::Attacher;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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

#[cfg(test)]
#[path = "tests/pty_init.rs"]
mod pty_init_tests;

/// Guest-side handle to a container registered in the zygote.
#[derive(Debug)]
pub struct Container {
    id: String,
    /// PID returned by the zygote at creation, before init starts running.
    init_pid: Option<nix::unistd::Pid>,
    bundle_path: PathBuf,
    rootfs: PathBuf,
    env: HashMap<String, String>,
    /// Resolved (uid, gid) from image USER directive, propagated to exec commands.
    user: (u32, u32),
    /// Destinations of every mount the applied OCI spec declares, plus those
    /// added later by `Container.Mount`.
    mount_destinations: Vec<PathBuf>,
    /// Attaches share folders into this container. `Container.Mount` holds it
    /// for writing while it attaches and records the mount; file copies hold
    /// it for reading, so no mount lands under a copy in progress.
    attacher: Arc<tokio::sync::RwLock<Attacher>>,
    /// Resolved capability set shared by init and every exec process.
    capabilities: CapabilitySet,
    /// Stdio pipes that keep init process alive.
    /// Dropping this closes pipes → init gets EOF → init exits.
    #[allow(dead_code)]
    stdio: ContainerStdio,
    #[cfg(test)]
    test_status: Option<Status>,
}

impl Container {
    /// Create init and its stdio without releasing the start gate.
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
        cgroup: ContainerCgroup,
    ) -> BoxliteResult<Self> {
        let rootfs = rootfs.as_ref();
        let workdir = workdir.as_ref();

        super::runner::validate_id(container_id)
            .map_err(|e| BoxliteError::InvalidArgument(e.to_string()))?;
        let bundle_path = GuestLayout::new().containers_dir().join(container_id);

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

        std::fs::create_dir_all(&bundle_path).map_err(|e| {
            BoxliteError::Internal(format!(
                "prepare container directory {}: {e}",
                bundle_path.display()
            ))
        })?;
        let result = (|| {
            start::create_container_etc_files(&bundle_path, container_id)?;
            let spec = spec::init_spec(
                rootfs,
                spec::ProcessSpec {
                    args: entrypoint,
                    env: env_map.clone(),
                    cwd: workdir.into(),
                    uid,
                    gid,
                    capabilities: capabilities.clone(),
                },
                readonly_paths.as_slice(),
                &mount_override,
                &bundle_path,
                &user_mounts,
                &devices,
                cgroup,
            );
            let mount_destinations = spec.mounts.iter().map(|m| m.destination.clone()).collect();
            let (stdio, init_fds) = if tty {
                (None, None)
            } else {
                let (stdio, fds) = ContainerStdio::pipes()?;
                (Some(stdio), Some(fds))
            };
            let raw_fds = init_fds.as_ref().map(|fds| {
                [
                    fds.stdin.as_raw_fd(),
                    fds.stdout.as_raw_fd(),
                    fds.stderr.as_raw_fd(),
                ]
            });
            let spawned = ZYGOTE.get().expect("zygote not started").build_init(
                InitBuildSpec {
                    container_id: container_id.into(),
                    spec,
                    pty_config: tty.then_some(DEFAULT_INIT_PTY),
                },
                raw_fds.as_ref().map_or(&[], |fds| &fds[..]),
            )?;
            let stdio = stdio
                .unwrap_or_else(|| ContainerStdio::pty(spawned.pty.expect("validated PTY reply")));
            Ok(Self {
                id: container_id.into(),
                init_pid: Some(spawned.pid),
                bundle_path: bundle_path.clone(),
                rootfs: rootfs.into(),
                env: env_map,
                user: (uid, gid),
                mount_destinations,
                attacher: Arc::default(),
                capabilities,
                stdio,
                #[cfg(test)]
                test_status: None,
            })
        })();
        if result.is_err() {
            start::cleanup_bundle_directory(&bundle_path);
        }
        result
    }

    /// Release init only after the caller can attach to its main command.
    /// Releasing the gate twice is a no-op for a running container.
    pub fn run_init(&self) -> BoxliteResult<()> {
        ZYGOTE.get().expect("zygote not started").run_init(&self.id)
    }

    fn status(&self) -> Status {
        #[cfg(test)]
        if let Some(status) = self.test_status {
            return status;
        }
        ZYGOTE
            .get()
            .and_then(|zygote| zygote.status(&self.id).ok())
            .unwrap_or(Status::Stopped)
    }

    pub fn is_running(&self) -> bool {
        self.status() == Status::Running
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

    /// Runtime mount identity checks require a workload that cannot change its
    /// own mount table. This policy is also the OCI bounding set for init and exec.
    pub(crate) fn ensure_runtime_mounts_supported(&self) -> BoxliteResult<()> {
        if self
            .capabilities
            .contains(&oci_spec::runtime::Capability::SysAdmin)
        {
            return Err(BoxliteError::Unsupported(
                "runtime directory mounts require a container without CAP_SYS_ADMIN".into(),
            ));
        }
        Ok(())
    }

    /// Destinations of every mount in the container: those it was created with,
    /// plus those `Container.Mount` added since (see
    /// [`Self::record_mount_destination`]).
    ///
    /// The initial list is taken from the same in-memory plan the runner uses.
    pub fn mount_destinations(&self) -> &[PathBuf] {
        &self.mount_destinations
    }

    /// Record a mount added to the running container (`Container.Mount`),
    /// so [`Self::mount_destinations`] still covers every mount it has.
    pub fn record_mount_destination(&mut self, destination: PathBuf) {
        self.mount_destinations.push(destination);
    }

    /// Includes both OCI mounts and directories delivered at runtime.
    pub(crate) fn has_mount_descendants(&self, destination: &Path) -> bool {
        self.mount_destinations
            .iter()
            .any(|mount| mount != destination && mount.starts_with(destination))
    }

    /// Remove only the runtime layer, retaining any underlying OCI mount.
    pub fn remove_mount_destination(&mut self, destination: &Path) {
        if let Some(index) = self
            .mount_destinations
            .iter()
            .rposition(|recorded| recorded == destination)
        {
            self.mount_destinations.remove(index);
        }
    }

    /// The attacher, behind the lock that orders mounts and copies (see the
    /// field). Taken without holding this container's lock.
    pub(crate) fn attacher(&self) -> Arc<tokio::sync::RwLock<Attacher>> {
        Arc::clone(&self.attacher)
    }

    /// PID assigned at creation. This is not a liveness check.
    pub fn init_pid(&self) -> Option<nix::unistd::Pid> {
        self.init_pid
    }

    #[cfg(test)]
    pub(crate) fn for_unit_test(id: &str, _unused: PathBuf, bundle_path: PathBuf) -> Self {
        std::fs::create_dir_all(&bundle_path).expect("create test container directory");
        Self {
            id: id.into(),
            init_pid: None,
            rootfs: bundle_path.join("rootfs"),
            bundle_path,
            env: HashMap::new(),
            user: (0, 0),
            mount_destinations: Vec::new(),
            attacher: Arc::default(),
            capabilities: CapabilitySet::default(),
            stdio: ContainerStdio::pipes().unwrap().0,
            test_status: Some(Status::Stopped),
        }
    }

    #[cfg(test)]
    pub(crate) fn mark_running_for_unit_test(&mut self) {
        self.test_status = Some(Status::Running);
    }

    /// Build the exec-session handle for the container's init process — the
    /// session the host attaches to as the box's *main command*.
    ///
    /// Whether init sits on pipes or a PTY is decided at container creation and
    /// is nobody else's business, so it is resolved here rather than leaking a
    /// tuple of fds and a terminal flag to the service layer.
    ///
    /// Returns `None` if no init PID was assigned or its stdio was already
    /// taken. Callable once, immediately after creation.
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
                // Init still waits for Container.Start at this point, unlike
                // an exec tenant whose build has already executed its workload.
                if let Err(error) = super::pty::initialize(&master, &DEFAULT_INIT_PTY) {
                    super::command::terminate_process(pid);
                    return Err(error);
                }
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
            self.env.clone(),
            self.user,
            self.rootfs.clone(),
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
        let (init_stdout, init_stderr) = self.drain_init_output();
        let mut result = format!("Container ID: {}, Status: {:?}", self.id, self.status());
        if let Some(pid) = self.init_pid {
            result.push_str(&format!(", PID: {pid}"));
            if let Ok(stat) = std::fs::read(format!("/proc/{pid}/stat")) {
                if let Some(state) = crate::service::exec::process_instance::stat_fields(&stat)
                    .and_then(|mut fields| fields.next())
                {
                    result.push_str(&format!(", Process state: {state}"));
                }
            }
        }

        // Append captured init output if any
        if !init_stdout.is_empty() {
            result.push_str(&format!(", Init stdout: {}", init_stdout.trim()));
        }
        if !init_stderr.is_empty() {
            result.push_str(&format!(", Init stderr: {}", init_stderr.trim()));
        }

        result
    }

    /// Send SIGTERM to init, then kill the PID namespace and cgroup on timeout.
    pub fn shutdown(&self, timeout_ms: u64) -> BoxliteResult<()> {
        let Some(zygote) = ZYGOTE.get() else {
            return Ok(());
        };
        if self.status() == Status::Running {
            zygote.signal(&self.id, false)?;
            let start = std::time::Instant::now();
            while start.elapsed().as_millis() < u128::from(timeout_ms) {
                if self.status() == Status::Stopped {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        zygote.signal(&self.id, true)
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
        #[cfg(test)]
        let registered = self.test_status.is_none();
        #[cfg(not(test))]
        let registered = true;
        if registered {
            if let Some(zygote) = ZYGOTE.get() {
                if let Err(error) = zygote.remove(&self.id) {
                    tracing::warn!(container_id = %self.id, %error, "failed to remove runner entry");
                }
            }
        }
        start::cleanup_bundle_directory(&self.bundle_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn runtime_mount_removal_preserves_oci_layers_and_descendant_bookkeeping() {
        let root = tempfile::tempdir().unwrap();
        let mut container = Container {
            id: "mount-bookkeeping".into(),
            bundle_path: root.path().join("bundle"),
            rootfs: root.path().join("bundle/rootfs"),
            env: HashMap::new(),
            user: (0, 0),
            mount_destinations: vec!["/data".into(), "/data/oci-child".into(), "/database".into()],
            attacher: Arc::default(),
            capabilities: CapabilitySet::default(),
            stdio: ContainerStdio::pipes().unwrap().0,
            init_pid: None,
            test_status: Some(Status::Stopped),
        };
        container.record_mount_destination("/data".into());
        container.record_mount_destination("/data/runtime-child".into());
        assert!(container.has_mount_descendants(Path::new("/data")));
        container.remove_mount_destination(Path::new("/data/runtime-child"));
        assert!(
            container.has_mount_descendants(Path::new("/data")),
            "OCI descendant still prevents detach"
        );
        container.remove_mount_destination(Path::new("/data"));
        assert_eq!(
            container.mount_destinations(),
            &[
                PathBuf::from("/data"),
                PathBuf::from("/data/oci-child"),
                PathBuf::from("/database"),
            ]
        );
        assert!(!container.has_mount_descendants(Path::new("/data/oci-child")));
        assert!(
            !container.has_mount_descendants(Path::new("/dat")),
            "prefixes are component-aware"
        );
        container.remove_mount_destination(Path::new("/absent"));
        assert_eq!(container.mount_destinations().len(), 3);
    }

    #[test]
    fn init_pipe_handle_failure_reaps_init() {
        // This fixture is a single process: killing the simulated init must
        // not leave a shell's child holding nextest's output pipes open.
        let child = ChildGuard(Command::new("sleep").arg("30").spawn().unwrap());
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
}
