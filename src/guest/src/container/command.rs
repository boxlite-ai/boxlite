//! Command builder for executing processes in containers
//!
//! Provides a builder pattern for spawning processes inside containers,
//! following the `std::process::Command` pattern.

use super::capabilities::CapabilitySet;
use super::zygote::{self, BuildSpec};
use super::SpawnFailure;
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

    /// Resolved capability set inherited by every exec process.
    capabilities: CapabilitySet,

    /// Working directory (None = use default "/")
    cwd: Option<String>,

    /// PTY configuration (set via with_pty())
    pty_config: Option<PtyConfig>,

    /// Trusted in-process workload selection. Public exec arguments never set
    /// this field, even if argv[0] matches the internal placeholder.
    ssh_workload: Option<crate::service::ssh::SshWorkload>,
}

impl ContainerCommand {
    /// Create new command builder
    ///
    /// This is public within the crate for use by Container::exec().
    /// Users should call `container.exec()` instead.
    pub(super) fn new(
        id: String,
        env: HashMap<String, String>,
        user: (u32, u32),
        rootfs: PathBuf,
        capabilities: CapabilitySet,
    ) -> Self {
        Self {
            program: None,
            args: Vec::new(),
            env,
            user,
            user_override: None,
            rootfs: Some(rootfs),
            capabilities,
            cwd: None,
            pty_config: None,
            ssh_workload: None,
            id,
        }
    }

    /// Enable PTY mode with configuration
    ///
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

    pub(crate) fn with_ssh_workload(mut self, workload: crate::service::ssh::SshWorkload) -> Self {
        let (program, args) = workload.placeholder();
        self.program = Some(program);
        self.args = args;
        self.ssh_workload = Some(workload);
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
    /// For PTY mode, this includes attaching the returned master.
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
        match self.spawn_build().await.map_err(SpawnFailure::into_error)? {
            SpawnResult::Ready(handle) => Ok(handle),
            SpawnResult::PtyPending(pending) => pending.finish(),
        }
    }

    /// Spawn via the zygote; PTY handle construction may be deferred.
    pub(crate) async fn spawn_build(self) -> Result<SpawnResult, SpawnFailure> {
        if let Some(pty_config) = self.pty_config.clone() {
            self.spawn_pty_build(pty_config).await
        } else {
            let handle = self.spawn_with_pipes().await?;
            Ok(SpawnResult::Ready(handle))
        }
    }

    /// Spawn process with pipes (standard mode).
    async fn spawn_with_pipes(self) -> Result<ExecHandle, SpawnFailure> {
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
        let pid = self.build_and_spawn(pipes).await?.pid;

        tracing::debug!(pid = pid.as_raw(), "spawned with pipes");
        // Non-PTY mode: stdout and stderr are separate pipes
        match ExecHandle::new(pid, stdin_write, stdout_read, Some(stderr_read)) {
            Ok(handle) => Ok(handle),
            Err(error) => {
                terminate_process(pid);
                Err(error.into())
            }
        }
    }

    /// The zygote returns the master over the existing SCM_RIGHTS channel.
    /// Defer AsyncFd registration and handle assembly to outside the container lock.
    async fn spawn_pty_build(self, config: PtyConfig) -> Result<SpawnResult, SpawnFailure> {
        let spawned = self.build_and_spawn(None).await?;
        Ok(SpawnResult::PtyPending(SpawnedPty {
            pid: spawned.pid,
            master: spawned.pty.expect("validated PTY reply"),
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

    /// Blocking IPC to the single-threaded launch server.
    async fn build_and_spawn(
        &self,
        pipes: Option<(OwnedFd, OwnedFd, OwnedFd)>,
    ) -> Result<super::runner::Spawned, SpawnFailure> {
        let program = self.program.clone().unwrap_or_default();
        let mut container_args = vec![program.clone()];
        container_args.extend_from_slice(self.args.as_slice());
        let ssh_workload = self.ssh_workload.clone();
        if self.pty_config.is_some()
            && ssh_workload
                .as_ref()
                .is_some_and(|workload| !workload.supports_pty())
        {
            return Err(BoxliteError::Config(
                "this internal SSH workload does not support a PTY".into(),
            )
            .into());
        }

        let (uid, gid) = self.resolve_exec_user()?;

        tracing::debug!(
            container_id = %self.id,
            program = %program,
            args = ?container_args,
            "sending build to zygote"
        );

        let build_start = std::time::Instant::now();
        tracing::debug!(
            container_id = %self.id,
            program = %program,
            "exec: build starting"
        );

        let spec = BuildSpec {
            container_id: self.id.clone(),
            ssh_workload,
            pty_config: self.pty_config.clone(),
            process: super::spec::ProcessSpec {
                cwd: self.cwd.clone().unwrap_or_else(|| "/".to_string()).into(),
                env: self.env.clone(),
                args: container_args.clone(),
                uid,
                gid,
                capabilities: self.capabilities.clone(),
            },
        };

        // Blocking IPC to zygote — use spawn_blocking to not block tokio.
        // pipes must live until sendmsg duplicates them via SCM_RIGHTS,
        // then drop to close the parent's copies (so pipe readers see EOF).
        let spawned = tokio::task::spawn_blocking(move || {
            let raw_fds = pipes
                .as_ref()
                .map(|(a, b, c)| [a.as_raw_fd(), b.as_raw_fd(), c.as_raw_fd()]);
            let result = zygote::ZYGOTE
                .get()
                .expect("zygote not started")
                .build(spec, raw_fds.as_ref().map_or(&[], |fds| &fds[..]));
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
                error = ?e,
                "zygote build failed"
            );
            e
        })?;

        tracing::debug!(
            container_id = %self.id,
            pid = spawned.pid.as_raw(),
            elapsed_ms = build_start.elapsed().as_millis() as u64,
            "exec: build completed"
        );

        Ok(spawned)
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
    /// PTY: child is running; the master is ready for handle construction.
    PtyPending(SpawnedPty),
}

pub(crate) struct SpawnedPty {
    pid: Pid,
    master: OwnedFd,
    config: PtyConfig,
}

impl SpawnedPty {
    pub(crate) fn finish(self) -> BoxliteResult<ExecHandle> {
        create_pty_child(self.pid, self.master, self.config)
    }
}

/// Create ExecHandle with PTY.
///
/// Attaches an initialized PTY master as stdin/stdout and stores its resize
/// controller. Never reset terminal settings here: the workload may already
/// have switched the terminal into raw mode.
///
/// In PTY mode, stderr is merged into stdout at the PTY level - there is only
/// ONE reader from the PTY master to avoid race conditions.
pub(crate) fn create_pty_child(
    pid: Pid,
    pty_master: OwnedFd,
    config: PtyConfig,
) -> BoxliteResult<ExecHandle> {
    let (stdin, stdout) = match reconcile_pty_fds(&pty_master) {
        Ok(fds) => fds,
        Err(error) => {
            terminate_process(pid);
            return Err(error);
        }
    };

    // PTY mode: stderr is None (merged into stdout)
    let mut child = match ExecHandle::new(pid, stdin, stdout, None) {
        Ok(handle) => handle,
        Err(error) => {
            terminate_process(pid);
            return Err(error);
        }
    };
    let pty_controller = pty_master_to_file(pty_master);
    child.set_pty(pty_controller, config);

    Ok(child)
}

pub(super) fn terminate_process(pid: Pid) {
    let _fence = crate::reaper::reap_fence();
    let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
    let _ = nix::sys::wait::waitpid(pid, None);
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
#[path = "tests/pty_startup.rs"]
mod pty_startup_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cmd() -> ContainerCommand {
        ContainerCommand::new(
            "test-container".to_string(),
            HashMap::new(),
            (0, 0),
            PathBuf::from("/tmp/rootfs"),
            CapabilitySet::default(),
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
            modes: Vec::new(),
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

    #[test]
    fn public_command_arguments_do_not_select_the_ssh_executor() {
        let (program, args) = crate::service::ssh::SshWorkload::Sftp.placeholder();
        let cmd = make_cmd().program(program).args(args);

        assert_eq!(cmd.ssh_workload, None);
    }

    #[test]
    fn trusted_ssh_workload_sets_typed_state_and_placeholder() {
        let workload = crate::service::ssh::SshWorkload::DirectStreamlocal {
            socket_path: "/run/service.sock".into(),
        };
        let (expected_program, expected_args) = workload.placeholder();
        let cmd = make_cmd().with_ssh_workload(workload.clone());

        assert_eq!(cmd.ssh_workload, Some(workload));
        assert_eq!(cmd.program, Some(expected_program));
        assert_eq!(cmd.args, expected_args);
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
