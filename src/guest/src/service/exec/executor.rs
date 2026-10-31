//! Process spawning for the two executors.
//!
//! - ContainerExecutor: runs commands inside OCI container
//! - GuestExecutor: runs commands directly on guest

use crate::container::{CommandRejection, Container, SpawnFailure};
use crate::service::exec::exec_handle::{ExecHandle, PtyConfig};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::ExecRequest;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Executes commands inside OCI container.
pub struct ContainerExecutor {
    container: Arc<Mutex<Container>>,
}

impl ContainerExecutor {
    pub fn new(container: Arc<Mutex<Container>>) -> Self {
        Self { container }
    }

    /// Get a clone of the container reference for status checking.
    pub fn container_ref(&self) -> Arc<Mutex<Container>> {
        self.container.clone()
    }

    pub(crate) async fn spawn_ssh_workload(
        &self,
        req: &ExecRequest,
        workload: crate::service::ssh::SshWorkload,
    ) -> BoxliteResult<ExecHandle> {
        self.spawn_request(req, Some(workload))
            .await
            .map_err(SpawnFailure::into_error)
    }

    pub(crate) async fn spawn_attempt(
        &self,
        req: &ExecRequest,
    ) -> Result<ExecHandle, SpawnFailure> {
        self.spawn_request(req, None).await
    }

    async fn spawn_request(
        &self,
        req: &ExecRequest,
        ssh_workload: Option<crate::service::ssh::SshWorkload>,
    ) -> Result<ExecHandle, SpawnFailure> {
        use crate::container::SpawnResult;

        let start = std::time::Instant::now();
        let pty_config = req.tty.as_ref().map(PtyConfig::try_from).transpose()?;

        // Phase 1 (mutex held): build command + zygote IPC.
        //
        // Serialize build+spawn: libcontainer's build() uses process-global
        // chdir(). Concurrent builds corrupt each other's cwd, causing hangs
        // in clone3/waitpid. The mutex is released BEFORE the PTY handshake
        // so a stuck console-socket doesn't block other execs or shutdown.
        let spawn_result = {
            let container = self.container.lock().await;

            let mut cmd = container
                .cmd()
                .program(&req.program)
                .args(&req.args)
                .envs(req.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));

            if let Some(workload) = ssh_workload {
                cmd = cmd.with_ssh_workload(workload);
            }

            if !req.workdir.is_empty() {
                cmd = cmd.current_dir(&req.workdir);
            }

            if let Some(tty) = pty_config {
                cmd = cmd.with_pty(tty);
            }

            if let Some(ref user) = req.user {
                cmd = cmd.with_user(user.clone());
            }

            cmd.spawn_build().await?
            // container mutex dropped here
        };

        // Phase 2 (no mutex): complete PTY handshake if needed.
        //
        // receive_pty_master() blocks on accept() + recvmsg() with a 30s
        // timeout. This does NOT need the container mutex — chdir() is done.
        let result = match spawn_result {
            SpawnResult::Ready(handle) => Ok(handle),
            SpawnResult::PtyPending(pending) => pending.finish().map_err(SpawnFailure::from),
        };

        tracing::info!(
            elapsed_ms = start.elapsed().as_millis() as u64,
            program = %req.program,
            "exec: spawn completed"
        );

        result
    }
}

/// Executes commands directly on guest (no container).
pub struct GuestExecutor;

impl GuestExecutor {
    /// Spawn directly in the guest.
    ///
    /// A refused program is [`SpawnFailure::Rejected`]; every other failure,
    /// including an unusable working directory, is [`SpawnFailure::Failed`].
    pub(crate) async fn spawn_attempt(
        &self,
        req: &ExecRequest,
    ) -> Result<ExecHandle, SpawnFailure> {
        if let Some(tty) = &req.tty {
            let config = PtyConfig::try_from(tty)?;
            spawn_with_pty(req, config)
        } else {
            spawn_with_pipes(req)
        }
    }
}

/// Turn `execve`'s error into a POSIX result about the program (missing: 127,
/// not executable: 126) or a guest fault. Codes and wording match the
/// container executor, so every exec caller sees one message shape.
fn classify_spawn_error(program: &str, workdir: &str, error: std::io::Error) -> SpawnFailure {
    // `Command::spawn` merges the `chdir` into the same error it reports for
    // `execve`; a configured working directory that cannot be entered is the
    // configuration's fault, not a verdict about the program.
    if !workdir.is_empty() && !working_directory_is_searchable(workdir) {
        return SpawnFailure::Failed(BoxliteError::Internal(format!(
            "working directory '{workdir}' is not usable: {error}"
        )));
    }
    let rejection = match error.kind() {
        std::io::ErrorKind::NotFound => CommandRejection {
            message: format!("executable '{program}' not found in $PATH"),
            exit_code: 127,
        },
        std::io::ErrorKind::PermissionDenied => CommandRejection {
            message: format!("executable '{program}' does not have correct permissions"),
            exit_code: 126,
        },
        _ => {
            return SpawnFailure::Failed(BoxliteError::Internal(format!(
                "Failed to spawn '{program}': {error}"
            )));
        }
    };
    SpawnFailure::Rejected(rejection)
}

/// Whether `path` can be entered: `chdir` requires search permission on every
/// component, which is what `X_OK` checks.
fn working_directory_is_searchable(path: &str) -> bool {
    use std::ffi::CString;

    let Ok(path) = CString::new(path) else {
        return false;
    };
    // SAFETY: `path` is a valid NUL-terminated string for the duration of the call.
    unsafe {
        nix::libc::faccessat(
            nix::libc::AT_FDCWD,
            path.as_ptr(),
            nix::libc::X_OK,
            nix::libc::AT_EACCESS,
        ) == 0
    }
}

/// Spawn process with pipes (standard mode).
fn spawn_with_pipes(req: &ExecRequest) -> Result<ExecHandle, SpawnFailure> {
    use nix::unistd::Pid;
    use std::os::unix::io::{FromRawFd, IntoRawFd};
    use std::process::Command;

    let mut cmd = Command::new(&req.program);
    cmd.args(&req.args);

    for (k, v) in &req.env {
        cmd.env(k, v);
    }

    if !req.workdir.is_empty() {
        cmd.current_dir(&req.workdir);
    }

    // Create pipes for stdin/stdout/stderr
    let (stdin_read, stdin_write) = nix::unistd::pipe()
        .map_err(|e| BoxliteError::Internal(format!("Failed to create stdin pipe: {}", e)))?;
    let (stdout_read, stdout_write) = nix::unistd::pipe()
        .map_err(|e| BoxliteError::Internal(format!("Failed to create stdout pipe: {}", e)))?;
    let (stderr_read, stderr_write) = nix::unistd::pipe()
        .map_err(|e| BoxliteError::Internal(format!("Failed to create stderr pipe: {}", e)))?;

    // Configure command to use our pipes.
    // into_raw_fd() transfers ownership from OwnedFd to Stdio, preventing double-close.
    unsafe {
        cmd.stdin(std::process::Stdio::from_raw_fd(stdin_read.into_raw_fd()));
        cmd.stdout(std::process::Stdio::from_raw_fd(stdout_write.into_raw_fd()));
        cmd.stderr(std::process::Stdio::from_raw_fd(stderr_write.into_raw_fd()));
    }

    let mut child = cmd
        .spawn()
        .map_err(|error| classify_spawn_error(&req.program, &req.workdir, error))?;

    let pid = child.id();

    // Non-PTY mode: stdout and stderr are separate pipes
    match ExecHandle::new(
        Pid::from_raw(pid as i32),
        stdin_write,
        stdout_read,
        Some(stderr_read),
    ) {
        Ok(handle) => Ok(handle),
        Err(error) => {
            terminate_child(&mut child);
            Err(error.into())
        }
    }
}

/// Spawn process with PTY (interactive mode).
fn spawn_with_pty(req: &ExecRequest, config: PtyConfig) -> Result<ExecHandle, SpawnFailure> {
    use nix::pty::{openpty, OpenptyResult, Winsize};
    use nix::unistd::{dup, Pid};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    // Create PTY pair
    let winsize = Winsize {
        ws_row: config.rows,
        ws_col: config.cols,
        ws_xpixel: config.x_pixels,
        ws_ypixel: config.y_pixels,
    };

    let OpenptyResult { master, slave } = openpty(Some(&winsize), None)
        .map_err(|e| BoxliteError::Internal(format!("Failed to create PTY: {}", e)))?;
    crate::service::exec::tty::apply_modes(&slave, &config.modes)?;

    // Get raw FD for use in pre_exec closure
    let slave_raw_fd = slave.as_raw_fd();

    // Duplicate slave FD for each stdio (Stdio::from_raw_fd takes ownership and will close)
    let slave_stdin = dup(slave.as_raw_fd())
        .map_err(|e| BoxliteError::Internal(format!("Failed to dup slave for stdin: {}", e)))?;
    let slave_stdout = dup(slave.as_raw_fd())
        .map_err(|e| BoxliteError::Internal(format!("Failed to dup slave for stdout: {}", e)))?;
    let slave_stderr = dup(slave.as_raw_fd())
        .map_err(|e| BoxliteError::Internal(format!("Failed to dup slave for stderr: {}", e)))?;

    // Build command
    let mut cmd = Command::new(&req.program);
    cmd.args(&req.args);

    for (k, v) in &req.env {
        cmd.env(k, v);
    }

    if !req.workdir.is_empty() {
        cmd.current_dir(&req.workdir);
    }

    // Configure child to use PTY slave as stdin/stdout/stderr
    // Each Stdio takes ownership of its dup'd FD
    unsafe {
        cmd.stdin(Stdio::from_raw_fd(slave_stdin));
        cmd.stdout(Stdio::from_raw_fd(slave_stdout));
        cmd.stderr(Stdio::from_raw_fd(slave_stderr));
    }

    // Set up session and controlling terminal in child
    unsafe {
        cmd.pre_exec(move || {
            // Create new session (detach from parent's controlling terminal)
            nix::unistd::setsid().map_err(std::io::Error::other)?;

            // Set the PTY slave as the controlling terminal
            if nix::libc::ioctl(slave_raw_fd, nix::libc::TIOCSCTTY, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }

            Ok(())
        });
    }

    let mut child = cmd
        .spawn()
        .map_err(|error| classify_spawn_error(&req.program, &req.workdir, error))?;

    let pid = child.id();

    // Close original slave in parent (child has its dup'd copies after fork)
    drop(slave);

    // Duplicate master FD for stdin and stdout only.
    // In PTY mode, stderr is merged into stdout at the PTY level - there is only
    // ONE reader from the PTY master. Creating separate readers would cause a race
    // condition where data could be captured by the "wrong" reader, resulting in
    // out-of-order output.
    let stdin_fd = match dup(master.as_raw_fd()) {
        Ok(fd) => fd,
        Err(error) => {
            terminate_child(&mut child);
            return Err(
                BoxliteError::Internal(format!("Failed to dup PTY for stdin: {error}")).into(),
            );
        }
    };
    let stdout_fd = match dup(master.as_raw_fd()) {
        Ok(fd) => fd,
        Err(error) => {
            terminate_child(&mut child);
            return Err(
                BoxliteError::Internal(format!("Failed to dup PTY for stdout: {error}")).into(),
            );
        }
    };

    let stdin = unsafe { OwnedFd::from_raw_fd(stdin_fd) };
    let stdout = unsafe { OwnedFd::from_raw_fd(stdout_fd) };

    // PTY mode: stderr is None (merged into stdout)
    let mut handle = match ExecHandle::new(Pid::from_raw(pid as i32), stdin, stdout, None) {
        Ok(handle) => handle,
        Err(error) => {
            terminate_child(&mut child);
            return Err(error.into());
        }
    };

    // Keep master FD for resize operations
    let pty_controller = {
        let fd = master.as_raw_fd();
        std::mem::forget(master); // Transfer ownership
        unsafe { std::fs::File::from_raw_fd(fd) }
    };
    handle.set_pty(pty_controller, config);

    Ok(handle)
}

fn terminate_child(child: &mut std::process::Child) {
    let _fence = crate::reaper::reap_fence();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(program: &str) -> boxlite_shared::ExecRequest {
        boxlite_shared::ExecRequest {
            execution_id: None,
            program: program.to_string(),
            args: Vec::new(),
            env: std::collections::HashMap::new(),
            workdir: String::new(),
            timeout_ms: 0,
            tty: None,
            user: None,
        }
    }

    fn expect_rejection(result: Result<ExecHandle, SpawnFailure>) -> CommandRejection {
        if let Err(SpawnFailure::Rejected(rejection)) = result {
            rejection
        } else {
            panic!("the command must be rejected, not run or faulted")
        }
    }

    #[tokio::test]
    async fn a_missing_program_is_rejected_with_127() {
        let rejection = expect_rejection(
            GuestExecutor
                .spawn_attempt(&request("/pol55/no-such-program"))
                .await,
        );

        assert_eq!(rejection.exit_code, 127);
        assert_eq!(
            rejection.message,
            "executable '/pol55/no-such-program' not found in $PATH"
        );
    }

    #[tokio::test]
    async fn a_non_executable_program_is_rejected_with_126() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("not-executable");
        std::fs::write(&program, "#!/bin/sh\n").unwrap();

        let rejection = expect_rejection(
            GuestExecutor
                .spawn_attempt(&request(program.to_str().unwrap()))
                .await,
        );

        assert_eq!(rejection.exit_code, 126);
        assert!(
            rejection
                .message
                .ends_with("does not have correct permissions"),
            "{}",
            rejection.message
        );
    }

    #[tokio::test]
    async fn a_pty_exec_rejects_a_missing_program_with_127() {
        let mut req = request("/pol55/no-such-pty-program");
        req.tty = Some(boxlite_shared::TtyConfig {
            rows: 24,
            cols: 80,
            x_pixels: 0,
            y_pixels: 0,
            modes: Vec::new(),
        });

        let rejection = expect_rejection(GuestExecutor.spawn_attempt(&req).await);

        assert_eq!(rejection.exit_code, 127);
    }

    #[tokio::test]
    async fn a_directory_error_stays_a_spawn_failure() {
        // ENOTDIR says nothing about the program, so it must not be reported
        // as an exit status.
        let result = GuestExecutor
            .spawn_attempt(&request("/etc/passwd/not-a-directory"))
            .await;

        assert!(
            matches!(result, Err(SpawnFailure::Failed(_))),
            "ENOTDIR must stay a spawn failure"
        );
        drop(result);
    }

    #[tokio::test]
    async fn a_missing_workdir_is_a_spawn_failure() {
        let mut req = request("/pol55/no-such-program");
        req.workdir = "/pol55/no-such-directory".to_string();

        let result = GuestExecutor.spawn_attempt(&req).await;

        assert!(
            matches!(result, Err(SpawnFailure::Failed(_))),
            "a missing workdir must stay a spawn failure"
        );
    }

    #[tokio::test]
    async fn a_missing_program_with_a_valid_workdir_still_returns_127() {
        let mut req = request("/pol55/no-such-program");
        req.workdir = "/".to_string();

        let rejection = expect_rejection(GuestExecutor.spawn_attempt(&req).await);

        assert_eq!(rejection.exit_code, 127);
    }

    #[tokio::test]
    async fn an_unenterable_workdir_is_not_a_program_verdict() {
        use std::os::unix::fs::PermissionsExt;

        if unsafe { nix::libc::geteuid() } == 0 {
            // Root can enter any directory, so the case cannot be produced.
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let workdir = dir.path().join("locked");
        std::fs::create_dir(&workdir).unwrap();
        std::fs::set_permissions(&workdir, std::fs::Permissions::from_mode(0o000)).unwrap();
        let mut req = request("/pol55/no-such-program");
        req.workdir = workdir.to_str().unwrap().to_string();

        let result = GuestExecutor.spawn_attempt(&req).await;

        std::fs::set_permissions(&workdir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            matches!(result, Err(SpawnFailure::Failed(_))),
            "a workdir failure must not become an exit status"
        );
    }

    #[test]
    fn terminate_child_kills_and_reaps_process() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .unwrap();

        terminate_child(&mut child);

        assert!(child.try_wait().unwrap().is_some());
    }
}
