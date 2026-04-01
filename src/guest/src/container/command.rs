//! Command builder for executing processes in containers
//!
//! Provides a builder pattern for spawning processes inside containers,
//! following the `std::process::Command` pattern.

use super::zygote::{self, BuildSpec};
use crate::service::exec::exec_handle::{ExecHandle, PtyConfig};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::unistd::Pid;
use std::collections::HashMap;
use std::os::unix::io::{AsRawFd, OwnedFd};
use std::path::PathBuf;

/// Command builder
///
/// Builds a command to execute inside a container with stdin/stdout/stderr.
/// Use the builder methods to configure the command, arguments, environment, and working directory.
///
/// # Example
///
/// ```no_run
/// # use guest::container::Container;
/// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
/// let mut child = container
///     .cmd()
///     .program("ls")
///     .args(&["-la", "/tmp"])
///     .env("FOO", "bar")
///     .current_dir("/home")
///     .spawn()
///     .await?;
/// # Ok(())
/// # }
/// ```
pub struct ContainerCommand {
    // Container context (provided by Container::cmd())
    id: String,

    state_root: PathBuf,

    /// Program to run (set via program())
    program: Option<String>,

    /// Command arguments (not including program)
    args: Vec<String>,

    /// Environment variable overrides
    env: HashMap<String, String>,

    /// Resolved (uid, gid) from container init, propagated to exec processes.
    user: (u32, u32),

    /// User override string (format: <name|uid>[:<group|gid>]).
    /// When set, resolved at spawn time via resolve_user().
    user_override: Option<String>,

    /// Rootfs path for resolving user overrides from /etc/passwd.
    rootfs: Option<PathBuf>,

    /// Working directory (None = use default "/")
    cwd: Option<String>,

    /// Console socket path for PTY (internal, set by spawn when pty_config is present)
    console_socket: Option<String>,

    /// PTY configuration (set via with_pty())
    pty_config: Option<PtyConfig>,
}

impl ContainerCommand {
    /// Create new command builder
    ///
    /// This is public within the crate for use by Container::exec().
    /// Users should call `container.exec()` instead.
    pub(super) fn new(
        id: String,
        state_root: PathBuf,
        env: HashMap<String, String>,
        user: (u32, u32),
        rootfs: PathBuf,
    ) -> Self {
        Self {
            program: None,
            args: Vec::new(),
            env,
            user,
            user_override: None,
            rootfs: Some(rootfs),
            cwd: None,
            console_socket: None,
            pty_config: None,
            id,
            state_root,
        }
    }

    /// Enable PTY mode with configuration
    ///
    /// Sets up console socket for OCI-compliant PTY handling.
    /// Call this before spawn() to enable PTY mode.
    pub fn with_pty(mut self, config: PtyConfig) -> Self {
        // Store config for spawn() to use
        self.pty_config = Some(config);
        self
    }

    /// Set user override for this exec.
    ///
    /// Format: `<name|uid>[:<group|gid>]` (same as `docker exec --user`).
    /// Resolved at spawn time from the container's /etc/passwd.
    pub fn with_user(mut self, user: String) -> Self {
        self.user_override = Some(user);
        self
    }

    /// Set the program to execute
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
    /// let child = container.exec().cmd("ls").spawn().await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn program(mut self, program: impl Into<String>) -> Self {
        self.program = Some(program.into());
        self
    }

    /// Add arguments (replaces existing)
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
    /// let child = container.command("ls").args(&["-la", "/tmp"]).spawn().await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.args = args.into_iter().map(|s| s.as_ref().to_string()).collect();
        self
    }

    /// Add single argument
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
    /// let child = container.command("ls").arg("-l").arg("-a").spawn().await?;
    /// # Ok(())
    /// # }
    /// ```
    #[allow(dead_code)] // API completeness for std::process::Command compatibility
    pub fn arg(mut self, arg: impl AsRef<str>) -> Self {
        self.args.push(arg.as_ref().to_string());
        self
    }

    /// Set environment variable
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
    /// let child = container.command("env").env("FOO", "bar").spawn().await?;
    /// # Ok(())
    /// # }
    /// ```
    #[allow(dead_code)] // API completeness for std::process::Command compatibility
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    /// Set multiple environment variables
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
    /// let vars = vec![("FOO", "bar"), ("BAZ", "qux")];
    /// let child = container.command("env").envs(vars).spawn().await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn envs<I, K, V>(mut self, vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        for (k, v) in vars {
            self.env.insert(k.into(), v.into());
        }
        self
    }

    /// Set working directory
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
    /// let child = container.command("pwd").current_dir("/tmp").spawn().await?;
    /// # Ok(())
    /// # }
    /// ```
    #[allow(dead_code)] // API completeness for std::process::Command compatibility
    pub fn current_dir(mut self, dir: impl Into<String>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    /// Spawn the process.
    ///
    /// Creates a tenant process in the container with stdin/stdout/stderr pipes.
    /// Returns an [`ExecHandle`] for interacting with the running process.
    ///
    /// For PTY mode, this includes the full console-socket handshake.
    /// If you need to release the container mutex between the zygote build
    /// and the PTY handshake, use [`spawn_build()`] + [`SpawnedPty::finish()`] instead.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use guest::container::Container;
    /// # use futures::StreamExt;
    /// # async fn example(container: &Container) -> Result<(), Box<dyn std::error::Error>> {
    /// let child = container.cmd().program("sh").args(&["-c", "echo hello"]).spawn().await?;
    /// # Ok(())
    /// # }
    /// ```
    #[allow(dead_code)] // Public API; ContainerExecutor uses spawn_build() for two-phase locking
    pub async fn spawn(self) -> BoxliteResult<ExecHandle> {
        match self.spawn_build().await? {
            SpawnResult::Ready(handle) => Ok(handle),
            SpawnResult::PtyPending(pending) => pending.finish(),
        }
    }

    /// Build phase only: zygote IPC without PTY handshake.
    ///
    /// Returns [`SpawnResult::Ready`] for non-PTY (handle ready immediately),
    /// or [`SpawnResult::PtyPending`] for PTY (must call [`SpawnedPty::finish()`]
    /// to complete the console-socket handshake).
    ///
    /// Use this instead of [`spawn()`] when you need to release the container
    /// mutex between the zygote build and the PTY handshake. The build phase
    /// serializes `chdir()` in libcontainer; the PTY handshake does not need it.
    pub(crate) async fn spawn_build(self) -> BoxliteResult<SpawnResult> {
        if let Some(pty_config) = self.pty_config.clone() {
            self.spawn_pty_build(pty_config).await
        } else {
            let handle = self.spawn_with_pipes().await?;
            Ok(SpawnResult::Ready(handle))
        }
    }

    /// Spawn process with pipes (standard mode).
    async fn spawn_with_pipes(self) -> BoxliteResult<ExecHandle> {
        use nix::unistd::pipe;

        // Create pipes for I/O
        let (stdin_read, stdin_write) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stdin pipe: {}", e)))?;
        let (stdout_read, stdout_write) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stdout pipe: {}", e)))?;
        let (stderr_read, stderr_write) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stderr pipe: {}", e)))?;

        tracing::debug!(container_id = %self.id, "spawning with pipes");

        let pipes = Some((stdin_read, stdout_write, stderr_write));
        let pid = self.build_and_spawn(pipes).await?;

        tracing::debug!(pid = pid.as_raw(), "spawned with pipes");
        // Non-PTY mode: stdout and stderr are separate pipes
        Ok(ExecHandle::new(
            pid,
            stdin_write,
            stdout_read,
            Some(stderr_read),
        ))
    }

    /// Build phase of PTY spawn: zygote IPC only, no console-socket handshake.
    ///
    /// Creates the console socket, sends the build spec to the zygote, and
    /// returns a [`SpawnedPty`] that captures the PID + socket for later
    /// completion via [`SpawnedPty::finish()`].
    async fn spawn_pty_build(mut self, config: PtyConfig) -> BoxliteResult<SpawnResult> {
        use super::console_socket::ConsoleSocket;

        let exec_id = uuid::Uuid::new_v4().to_string();
        let socket = ConsoleSocket::new(&exec_id)?;

        tracing::debug!(
            container_id = %self.id,
            console_socket = %socket.path(),
            "spawning with PTY (build phase)"
        );

        self.console_socket = Some(socket.path().to_string());
        let pid = self.build_and_spawn(None).await?;

        Ok(SpawnResult::PtyPending(SpawnedPty {
            pid,
            socket,
            config,
        }))
    }

    /// Resolve the effective (uid, gid) for this exec.
    ///
    /// If `user_override` is set, resolves it against the container's /etc/passwd.
    /// Otherwise, returns the init default `self.user`.
    fn resolve_exec_user(&self) -> BoxliteResult<(u32, u32)> {
        match self.user_override {
            Some(ref spec) => {
                let rootfs_str =
                    self.rootfs
                        .as_ref()
                        .and_then(|p| p.to_str())
                        .ok_or_else(|| {
                            BoxliteError::Internal(
                                "Missing rootfs path for user resolution".to_string(),
                            )
                        })?;
                super::spec::resolve_user(rootfs_str, spec)
            }
            None => Ok(self.user),
        }
    }

    /// Build and spawn process via the zygote.
    ///
    /// Sends a BuildSpec to the zygote process (forked before tokio started),
    /// which calls ContainerBuilder::build() in a single-threaded context.
    /// This avoids the musl __malloc_lock deadlock on clone3().
    ///
    /// Uses spawn_blocking because the IPC round-trip blocks until the
    /// zygote completes the build.
    async fn build_and_spawn(
        &self,
        pipes: Option<(OwnedFd, OwnedFd, OwnedFd)>,
    ) -> BoxliteResult<Pid> {
        let program = self.program.clone().unwrap_or_default();
        let mut container_args = vec![program.clone()];
        container_args.extend_from_slice(self.args.as_slice());

        let (uid, gid) = self.resolve_exec_user()?;

        tracing::debug!(
            container_id = %self.id,
            program = %program,
            args = ?container_args,
            "sending build to zygote"
        );

        let build_start = std::time::Instant::now();
        tracing::info!(
            container_id = %self.id,
            program = %program,
            "exec: build starting"
        );

        let spec = BuildSpec {
            container_id: self.id.clone(),
            state_root: self.state_root.clone(),
            console_socket: self.console_socket.clone(),
            cwd: self.cwd.clone().unwrap_or_else(|| "/".to_string()).into(),
            env: self.env.clone(),
            args: container_args.clone(),
            uid,
            gid,
        };

        // Blocking IPC to zygote — use spawn_blocking to not block tokio.
        // pipes must live until sendmsg duplicates them via SCM_RIGHTS,
        // then drop to close the parent's copies (so pipe readers see EOF).
        let pid = tokio::task::spawn_blocking(move || {
            let raw_fds = pipes
                .as_ref()
                .map(|(a, b, c)| [a.as_raw_fd(), b.as_raw_fd(), c.as_raw_fd()]);
            let result = zygote::ZYGOTE
                .get()
                .expect("zygote not started")
                .build(spec, raw_fds);
            // Close parent's copies AFTER build() — zygote has its own via SCM_RIGHTS.
            // Without this, pipe readers in the parent never see EOF.
            drop(pipes);
            result
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("build join error: {e}")))?
        .map_err(|e| {
            tracing::error!(
                container_id = %self.id,
                program = %program,
                args = ?container_args,
                error = %e,
                "zygote build failed"
            );
            e
        })?;

        tracing::info!(
            container_id = %self.id,
            pid = pid.as_raw(),
            elapsed_ms = build_start.elapsed().as_millis() as u64,
            "exec: build completed"
        );

        Ok(pid)
    }
}

/// Result of [`ContainerCommand::spawn_build()`].
///
/// Non-PTY commands produce a ready [`ExecHandle`] immediately.
/// PTY commands produce a [`SpawnedPty`] that must be completed
/// via [`SpawnedPty::finish()`] after releasing the container mutex.
pub(crate) enum SpawnResult {
    /// Non-PTY: handle is ready immediately.
    Ready(ExecHandle),
    /// PTY: build is done, but the console-socket handshake is pending.
    PtyPending(SpawnedPty),
}

/// Intermediate state between zygote build and PTY handshake.
///
/// Holds the PID (from `build_and_spawn`) and the console socket
/// needed to receive the PTY master FD from libcontainer.
///
/// Call [`finish()`] to complete the handshake. This blocks on
/// `accept()` + `recvmsg()` with a 30s timeout.
pub(crate) struct SpawnedPty {
    pid: Pid,
    socket: super::console_socket::ConsoleSocket,
    config: PtyConfig,
}

impl SpawnedPty {
    /// Complete the PTY handshake and create the [`ExecHandle`].
    ///
    /// Blocks on the console-socket `accept()` + `recvmsg()` to receive
    /// the PTY master FD from libcontainer. Has a 30s timeout.
    ///
    /// Call this AFTER releasing the container mutex — the handshake
    /// does not need serialization.
    pub(crate) fn finish(self) -> BoxliteResult<ExecHandle> {
        let pty_master = self.socket.receive_pty_master()?;
        create_pty_child(self.pid, pty_master, self.config)
    }
}

/// Create ExecHandle with PTY.
///
/// Sets terminal window size, reconciles PTY master FD as stdin/stdout,
/// and stores PTY controller for later resizing.
///
/// In PTY mode, stderr is merged into stdout at the PTY level - there is only
/// ONE reader from the PTY master to avoid race conditions.
fn create_pty_child(pid: Pid, pty_master: OwnedFd, config: PtyConfig) -> BoxliteResult<ExecHandle> {
    set_pty_window_size(&pty_master, &config)?;
    let (stdin, stdout) = reconcile_pty_fds(&pty_master)?;

    // PTY mode: stderr is None (merged into stdout)
    let mut child = ExecHandle::new(pid, stdin, stdout, None);
    let pty_controller = pty_master_to_file(pty_master);
    child.set_pty(pty_controller, config);

    Ok(child)
}

/// Set PTY terminal window size via ioctl.
fn set_pty_window_size(pty_master: &OwnedFd, config: &PtyConfig) -> BoxliteResult<()> {
    use nix::pty::Winsize;
    use std::os::fd::AsRawFd;

    let winsize = Winsize {
        ws_row: config.rows,
        ws_col: config.cols,
        ws_xpixel: config.x_pixels,
        ws_ypixel: config.y_pixels,
    };

    unsafe {
        if nix::libc::ioctl(
            pty_master.as_raw_fd(),
            nix::libc::TIOCSWINSZ,
            &winsize as *const _,
        ) == -1
        {
            let errno = std::io::Error::last_os_error();
            return Err(BoxliteError::Internal(format!(
                "Failed to set PTY window size ({}x{}): {}",
                config.rows, config.cols, errno
            )));
        }
    }

    Ok(())
}

/// Duplicate PTY master FD for stdin and stdout only.
///
/// In PTY mode, stderr is merged into stdout - we only create ONE reader
/// from the PTY master to avoid race conditions. See `create_pty_child`.
fn reconcile_pty_fds(pty_master: &OwnedFd) -> BoxliteResult<(OwnedFd, OwnedFd)> {
    use nix::unistd::dup;
    use std::os::fd::{AsRawFd, FromRawFd};

    let stdin_fd = dup(pty_master.as_raw_fd())
        .map_err(|e| BoxliteError::Internal(format!("Failed to dup PTY for stdin: {}", e)))?;
    let stdout_fd = dup(pty_master.as_raw_fd())
        .map_err(|e| BoxliteError::Internal(format!("Failed to dup PTY for stdout: {}", e)))?;

    Ok((unsafe { OwnedFd::from_raw_fd(stdin_fd) }, unsafe {
        OwnedFd::from_raw_fd(stdout_fd)
    }))
}

/// Convert OwnedFd to File for PTY controller.
///
/// The PTY controller is kept for later resizing operations.
fn pty_master_to_file(pty_master: OwnedFd) -> std::fs::File {
    use std::os::fd::{AsRawFd, FromRawFd};

    let fd = pty_master.as_raw_fd();
    std::mem::forget(pty_master); // Transfer ownership, don't close
    unsafe { std::fs::File::from_raw_fd(fd) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cmd() -> ContainerCommand {
        ContainerCommand::new(
            "test-container".to_string(),
            PathBuf::from("/tmp/state"),
            HashMap::new(),
            (0, 0),
            PathBuf::from("/tmp/rootfs"),
        )
    }

    #[test]
    fn test_with_user_override_sets_field() {
        let cmd = make_cmd().with_user("abc:staff".to_string());
        assert_eq!(cmd.user_override, Some("abc:staff".to_string()));
    }

    #[test]
    fn test_without_user_uses_default() {
        let cmd = make_cmd();
        assert_eq!(cmd.user_override, None);
        assert_eq!(cmd.user, (0, 0));
    }

    #[test]
    fn test_with_user_numeric() {
        let cmd = make_cmd().with_user("1000:1000".to_string());
        assert_eq!(cmd.user_override, Some("1000:1000".to_string()));
    }

    // ========================================================================
    // BUILDER PATTERN TESTS
    // ========================================================================

    #[test]
    fn test_builder_program() {
        let cmd = make_cmd().program("ls");
        assert_eq!(cmd.program, Some("ls".to_string()));
    }

    #[test]
    fn test_builder_args_replaces() {
        let cmd = make_cmd().arg("first").args(["second", "third"]);
        assert_eq!(cmd.args, vec!["second".to_string(), "third".to_string()]);
    }

    #[test]
    fn test_builder_arg_appends() {
        let cmd = make_cmd().arg("first").arg("second");
        assert_eq!(cmd.args, vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn test_builder_env_single() {
        let cmd = make_cmd().env("KEY", "VALUE");
        assert_eq!(cmd.env.get("KEY"), Some(&"VALUE".to_string()));
    }

    #[test]
    fn test_builder_envs_merges_and_overrides() {
        let cmd = make_cmd().env("A", "1").envs(vec![("B", "2"), ("A", "3")]);
        assert_eq!(cmd.env.get("A"), Some(&"3".to_string()));
        assert_eq!(cmd.env.get("B"), Some(&"2".to_string()));
    }

    #[test]
    fn test_builder_current_dir() {
        let cmd = make_cmd().current_dir("/home");
        assert_eq!(cmd.cwd, Some("/home".to_string()));
    }

    #[test]
    fn test_builder_with_pty() {
        let config = PtyConfig {
            rows: 24,
            cols: 80,
            x_pixels: 0,
            y_pixels: 0,
        };
        let cmd = make_cmd().with_pty(config);
        let pty = cmd.pty_config.unwrap();
        assert_eq!(pty.rows, 24);
        assert_eq!(pty.cols, 80);
    }

    #[test]
    fn test_builder_full_chain() {
        let cmd = make_cmd()
            .program("sh")
            .args(["-c", "echo hello"])
            .env("FOO", "bar")
            .envs(vec![("BAZ", "qux")])
            .current_dir("/tmp")
            .with_user("nobody".to_string());

        assert_eq!(cmd.program, Some("sh".to_string()));
        assert_eq!(cmd.args, vec!["-c".to_string(), "echo hello".to_string()]);
        assert_eq!(cmd.env.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(cmd.env.get("BAZ"), Some(&"qux".to_string()));
        assert_eq!(cmd.cwd, Some("/tmp".to_string()));
        assert_eq!(cmd.user_override, Some("nobody".to_string()));
    }

    // ========================================================================
    // RESOLVE EXEC USER TESTS
    // ========================================================================

    #[test]
    fn test_resolve_exec_user_default() {
        let cmd = make_cmd();
        let (uid, gid) = cmd.resolve_exec_user().unwrap();
        assert_eq!((uid, gid), (0, 0));
    }

    #[test]
    fn test_resolve_exec_user_override_without_valid_rootfs() {
        let mut cmd = make_cmd().with_user("nobody".to_string());
        cmd.rootfs = None;
        let result = cmd.resolve_exec_user();
        assert!(result.is_err());
    }
}
