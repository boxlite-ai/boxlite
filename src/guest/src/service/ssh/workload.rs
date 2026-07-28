//! BoxLite workloads executed by libcontainer after tenant setup.

use super::{limits, reverse_streamlocal, session, sftp, streamlocal};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use libcontainer::oci_spec::runtime::Spec;
use libcontainer::workload::{Executor, ExecutorError, ExecutorValidationError};
use serde::{Deserialize, Serialize};
use std::net::SocketAddrV4;

/// Reserved OCI argv[0] used to represent a typed workload in the process spec.
/// It is a validation placeholder, not a selector or container filesystem path.
pub(crate) const INTERNAL_PROGRAM: &str = "boxlite-internal:ssh";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum SshWorkload {
    Shell,
    Exec {
        command: String,
    },
    Sftp,
    DirectStreamlocal {
        socket_path: String,
    },
    ReverseStreamlocal {
        socket_path: String,
        ingress: SocketAddrV4,
    },
}

impl SshWorkload {
    pub(crate) fn placeholder(&self) -> (String, Vec<String>) {
        let args = match self {
            Self::Shell => vec![session::INTERNAL_SESSION_ARG.into(), "shell".into()],
            Self::Exec { command } => vec![
                session::INTERNAL_SESSION_ARG.into(),
                "exec".into(),
                command.clone(),
            ],
            Self::Sftp => vec![sftp::INTERNAL_SFTP_ARG.into()],
            Self::DirectStreamlocal { socket_path } => vec![
                streamlocal::INTERNAL_STREAMLOCAL_ARG.into(),
                socket_path.clone(),
            ],
            Self::ReverseStreamlocal {
                socket_path,
                ingress,
            } => vec![
                reverse_streamlocal::INTERNAL_REVERSE_STREAMLOCAL_ARG.into(),
                socket_path.clone(),
                ingress.to_string(),
            ],
        };
        (INTERNAL_PROGRAM.into(), args)
    }

    /// Parse the reserved argv shape when validating typed zygote state.
    /// Executor selection never uses this parser: only the private in-process
    /// SSH launch path can populate `BuildSpec::ssh_workload`.
    pub(crate) fn from_container_args(args: &[String]) -> BoxliteResult<Option<Self>> {
        if args.first().map(String::as_str) != Some(INTERNAL_PROGRAM) {
            return Ok(None);
        }
        let [_, selector, workload_args @ ..] = args else {
            return Err(BoxliteError::Config(
                "internal SSH workload requires a selector".into(),
            ));
        };

        let workload = match selector.as_str() {
            session::INTERNAL_SESSION_ARG => match session::parse_internal_args(workload_args)? {
                session::SessionAction::Shell => Self::Shell,
                session::SessionAction::Exec(command) => {
                    if command.len() > limits::MAX_COMMAND_BYTES || command.contains('\0') {
                        return Err(BoxliteError::Config(
                            "internal SSH command is too large or contains NUL".into(),
                        ));
                    }
                    Self::Exec { command }
                }
            },
            sftp::INTERNAL_SFTP_ARG if workload_args.is_empty() => Self::Sftp,
            sftp::INTERNAL_SFTP_ARG => {
                return Err(BoxliteError::Config(
                    "internal SFTP workload does not accept arguments".into(),
                ));
            }
            streamlocal::INTERNAL_STREAMLOCAL_ARG => Self::DirectStreamlocal {
                socket_path: streamlocal::parse_internal_args(workload_args)?,
            },
            reverse_streamlocal::INTERNAL_REVERSE_STREAMLOCAL_ARG => {
                let args = reverse_streamlocal::parse_internal_args(workload_args)?;
                Self::ReverseStreamlocal {
                    socket_path: args.socket_path,
                    ingress: args.ingress,
                }
            }
            _ => {
                return Err(BoxliteError::Config(format!(
                    "unknown internal SSH workload selector: {selector}"
                )));
            }
        };
        Ok(Some(workload))
    }

    pub(crate) fn supports_pty(&self) -> bool {
        matches!(self, Self::Shell | Self::Exec { .. })
    }

    fn run(self) -> BoxliteResult<()> {
        match self {
            Self::Shell => session::run_internal(session::SessionAction::Shell),
            Self::Exec { command } => session::run_internal(session::SessionAction::Exec(command)),
            Self::Sftp => {
                session::prepare_sftp_home()?;
                sftp::run_internal()
            }
            Self::DirectStreamlocal { socket_path } => streamlocal::run_internal(socket_path),
            Self::ReverseStreamlocal {
                socket_path,
                ingress,
            } => reverse_streamlocal::run_internal(reverse_streamlocal::InternalArgs {
                socket_path,
                ingress,
            }),
        }
    }

    fn is_direct_rust(&self) -> bool {
        !matches!(self, Self::Shell | Self::Exec { .. })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct BoxliteWorkloadExecutor {
    workload: SshWorkload,
}

impl BoxliteWorkloadExecutor {
    pub(crate) fn new(workload: SshWorkload) -> Self {
        Self { workload }
    }

    fn validate_spec(&self, spec: &Spec) -> BoxliteResult<()> {
        let process = spec.process().as_ref().ok_or_else(|| {
            BoxliteError::Config("internal SSH workload requires an OCI process".into())
        })?;
        let args = process.args().as_deref().ok_or_else(|| {
            BoxliteError::Config("internal SSH workload requires process arguments".into())
        })?;
        if process.user().uid() != 0 || process.user().gid() != 0 {
            return Err(BoxliteError::Config(
                "internal SSH workloads must run as container root".into(),
            ));
        }
        let parsed = SshWorkload::from_container_args(args)?.ok_or_else(|| {
            BoxliteError::Config("internal SSH workload placeholder is missing".into())
        })?;
        if parsed != self.workload {
            return Err(BoxliteError::Config(
                "internal SSH workload does not match its OCI placeholder".into(),
            ));
        }
        if process.terminal().unwrap_or(false) && !self.workload.supports_pty() {
            return Err(BoxliteError::Config(
                "this internal SSH workload does not support a PTY".into(),
            ));
        }
        Ok(())
    }
}

impl Executor for BoxliteWorkloadExecutor {
    fn exec(&self, spec: &Spec) -> Result<(), ExecutorError> {
        self.validate_spec(spec).map_err(executor_error)?;
        let workload = self.workload.clone();
        if !workload.is_direct_rust() {
            return workload.run().map_err(executor_error);
        }

        install_direct_workload_panic_hook();

        // Youki normally marks these descriptors CLOEXEC and waits for execve
        // to close its notification pipe. Direct Rust workloads do not exec,
        // so this real close is both the readiness boundary and leak defense.
        close_inherited_fds().map_err(executor_error)?;

        match workload.run() {
            Ok(()) => exit_without_inherited_handlers(0),
            Err(error) => {
                eprintln!("[ssh-workload] {error}");
                use std::io::Write as _;
                let _ = std::io::stderr().flush();
                exit_without_inherited_handlers(1);
            }
        }
    }

    fn validate(&self, spec: &Spec) -> Result<(), ExecutorValidationError> {
        self.validate_spec(spec)
            .map_err(|error| ExecutorValidationError::ArgValidationError(error.to_string()))
    }
}

fn executor_error(error: BoxliteError) -> ExecutorError {
    ExecutorError::Execution(Box::new(error))
}

fn close_inherited_fds() -> BoxliteResult<()> {
    let result = unsafe { nix::libc::syscall(nix::libc::SYS_close_range, 3_u32, u32::MAX, 0_u32) };
    if result == 0 {
        return Ok(());
    }

    let error = std::io::Error::last_os_error();
    if !matches!(
        error.raw_os_error(),
        Some(nix::libc::ENOSYS) | Some(nix::libc::EINVAL) | Some(nix::libc::EPERM)
    ) {
        return Err(BoxliteError::Internal(format!(
            "close inherited SSH workload descriptors: {error}"
        )));
    }

    let descriptors = {
        let mut descriptors = Vec::new();
        for entry in std::fs::read_dir("/proc/self/fd").map_err(|fallback_error| {
            BoxliteError::Internal(format!(
                "enumerate inherited SSH workload descriptors after close_range failed ({error}): {fallback_error}"
            ))
        })? {
            let entry = entry.map_err(|fallback_error| {
                BoxliteError::Internal(format!(
                    "read inherited SSH workload descriptor: {fallback_error}"
                ))
            })?;
            let Some(descriptor) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
            else {
                continue;
            };
            if descriptor >= 3 {
                descriptors.push(descriptor);
            }
        }
        descriptors
    };

    let mut close_error = None;
    for descriptor in descriptors {
        if unsafe { nix::libc::close(descriptor) } == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(nix::libc::EBADF) && close_error.is_none() {
                close_error = Some((descriptor, error));
            }
        }
    }
    if let Some((descriptor, error)) = close_error {
        // Closing any descriptor >= 3 crosses Youki's logical exec boundary:
        // its parent may already have observed EOF on the exec-notify pipe.
        // Never return into libcontainer after that point.
        eprintln!("[ssh-workload] close inherited descriptor {descriptor}: {error}");
        use std::io::Write as _;
        let _ = std::io::stderr().flush();
        exit_without_inherited_handlers(1);
    }
    Ok(())
}

fn install_direct_workload_panic_hook() {
    std::panic::set_hook(Box::new(|_| {
        const MESSAGE: &[u8] = b"[ssh-workload] internal workload panicked\n";
        unsafe {
            nix::libc::write(
                nix::libc::STDERR_FILENO,
                MESSAGE.as_ptr().cast(),
                MESSAGE.len(),
            );
            nix::libc::_exit(101);
        }
    }));
}

fn exit_without_inherited_handlers(status: i32) -> ! {
    unsafe { nix::libc::_exit(status) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libcontainer::oci_spec::runtime::{ProcessBuilder, SpecBuilder, UserBuilder};
    use std::fs;
    use std::io::{Read as _, Write as _};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    const SUBPROCESS_CASE: &str = "BOXLITE_SSH_WORKLOAD_SUBPROCESS";
    const SUBPROCESS_COMMAND: &str = "BOXLITE_SSH_WORKLOAD_COMMAND";
    const SUBPROCESS_TEST: &str =
        "service::ssh::workload::tests::internal_workload_subprocess_driver";

    fn spec(args: &[&str], terminal: bool) -> Spec {
        let user = UserBuilder::default()
            .uid(0_u32)
            .gid(0_u32)
            .build()
            .unwrap();
        let process = ProcessBuilder::default()
            .terminal(terminal)
            .user(user)
            .args(
                args.iter()
                    .map(|value| (*value).to_string())
                    .collect::<Vec<_>>(),
            )
            .env(vec!["PATH=/bin:/usr/bin".to_string()])
            .cwd("/")
            .build()
            .unwrap();
        SpecBuilder::default().process(process).build().unwrap()
    }

    fn parse(args: &[&str]) -> BoxliteResult<Option<SshWorkload>> {
        SshWorkload::from_container_args(
            &args
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn ordinary_commands_do_not_select_a_custom_workload() {
        assert_eq!(parse(&["/bin/true"]).unwrap(), None);
    }

    #[test]
    fn every_internal_workload_round_trips_through_zygote_serialization() {
        let workloads = [
            SshWorkload::Shell,
            SshWorkload::Exec {
                command: "printf '%s' hello".into(),
            },
            SshWorkload::Sftp,
            SshWorkload::DirectStreamlocal {
                socket_path: "/run/service.sock".into(),
            },
            SshWorkload::ReverseStreamlocal {
                socket_path: "/run/service.sock".into(),
                ingress: "127.0.0.1:32000".parse().unwrap(),
            },
        ];
        for workload in workloads {
            let encoded = serde_json::to_vec(&workload).unwrap();
            let decoded: SshWorkload = serde_json::from_slice(&encoded).unwrap();
            assert_eq!(decoded, workload);
        }
    }

    #[test]
    fn validates_every_internal_workload_shape() {
        let cases = [
            (
                vec![INTERNAL_PROGRAM, session::INTERNAL_SESSION_ARG, "shell"],
                false,
            ),
            (
                vec![
                    INTERNAL_PROGRAM,
                    session::INTERNAL_SESSION_ARG,
                    "exec",
                    "printf '%s' hello",
                ],
                true,
            ),
            (vec![INTERNAL_PROGRAM, sftp::INTERNAL_SFTP_ARG], false),
            (
                vec![
                    INTERNAL_PROGRAM,
                    streamlocal::INTERNAL_STREAMLOCAL_ARG,
                    "/run/service.sock",
                ],
                false,
            ),
            (
                vec![
                    INTERNAL_PROGRAM,
                    reverse_streamlocal::INTERNAL_REVERSE_STREAMLOCAL_ARG,
                    "/run/service.sock",
                    "127.0.0.1:32000",
                ],
                false,
            ),
        ];
        for (args, terminal) in cases {
            let workload = parse(&args).unwrap().unwrap();
            BoxliteWorkloadExecutor::new(workload)
                .validate(&spec(&args, terminal))
                .unwrap();
        }
    }

    #[test]
    fn rejects_unknown_ambiguous_or_mismatched_internal_workloads() {
        for args in [
            vec![INTERNAL_PROGRAM],
            vec![INTERNAL_PROGRAM, "unknown"],
            vec![INTERNAL_PROGRAM, sftp::INTERNAL_SFTP_ARG, "extra"],
            vec![INTERNAL_PROGRAM, session::INTERNAL_SESSION_ARG, "exec"],
            vec![
                INTERNAL_PROGRAM,
                streamlocal::INTERNAL_STREAMLOCAL_ARG,
                "relative.sock",
            ],
            vec![
                INTERNAL_PROGRAM,
                reverse_streamlocal::INTERNAL_REVERSE_STREAMLOCAL_ARG,
                "/run/service.sock",
                "192.0.2.1:32000",
            ],
        ] {
            assert!(parse(&args).is_err(), "accepted {args:?}");
        }

        let args = [INTERNAL_PROGRAM, session::INTERNAL_SESSION_ARG, "shell"];
        assert!(BoxliteWorkloadExecutor::new(SshWorkload::Sftp)
            .validate(&spec(&args, false))
            .is_err());
    }

    #[test]
    fn rejects_a_pty_for_protocol_and_relay_workloads() {
        let args = [INTERNAL_PROGRAM, sftp::INTERNAL_SFTP_ARG];
        assert!(BoxliteWorkloadExecutor::new(SshWorkload::Sftp)
            .validate(&spec(&args, true))
            .is_err());
    }

    #[test]
    fn rejects_non_root_internal_workloads() {
        let args = [INTERNAL_PROGRAM, sftp::INTERNAL_SFTP_ARG];
        let process = ProcessBuilder::default()
            .terminal(false)
            .user(
                UserBuilder::default()
                    .uid(1000_u32)
                    .gid(1000_u32)
                    .build()
                    .unwrap(),
            )
            .args(args.map(str::to_owned).to_vec())
            .env(vec!["PATH=/bin:/usr/bin".to_string()])
            .cwd("/")
            .build()
            .unwrap();
        let non_root_spec = SpecBuilder::default().process(process).build().unwrap();

        assert!(BoxliteWorkloadExecutor::new(SshWorkload::Sftp)
            .validate(&non_root_spec)
            .is_err());
    }

    fn spawn_subprocess(case: &str, cwd: &Path) -> Child {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                SUBPROCESS_TEST,
                "--nocapture",
                "--test-threads=1",
            ])
            .env(SUBPROCESS_CASE, case)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn isolated SSH workload test")
    }

    fn wait_for_cwd(child: &mut Child, expected: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().unwrap().is_some() {
                let mut stderr = String::new();
                child
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut stderr)
                    .unwrap();
                panic!("workload exited before entering {expected:?}: {stderr}");
            }
            if matches!(
                fs::read_link(format!("/proc/{}/cwd", child.id())),
                Ok(path) if path == expected
            ) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "workload never entered {expected:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn root_record() -> (PathBuf, PathBuf) {
        let passwd = fs::read_to_string("/etc/passwd").unwrap();
        let fields = passwd
            .lines()
            .find_map(|line| {
                let fields = line.split(':').collect::<Vec<_>>();
                (fields.len() >= 7 && fields[0] == "root").then_some(fields)
            })
            .expect("Linux test environment has a root passwd entry");
        (fields[5].into(), fields[6].into())
    }

    /// Mirror the fallback in `session::enter_root_home`.
    ///
    /// Existence is not enough: the session chdir's into this directory, so it
    /// needs search permission. In a container the workload is root and always
    /// has it; under `cargo test` the runner is whoever invoked it, and root's
    /// home is typically 0700 — so an unprivileged run legitimately lands on
    /// `/` and the expectation has to follow.
    fn selected_home(home: PathBuf) -> PathBuf {
        let traversable =
            home.is_dir() && nix::unistd::access(&home, nix::unistd::AccessFlags::X_OK).is_ok();
        if home.is_absolute() && traversable {
            home
        } else {
            PathBuf::from("/")
        }
    }

    /// Values the SSH session never chooses, seeded into the subprocess so an
    /// assertion on `$HOME`/`$SHELL` cannot be satisfied by what the runner
    /// happened to export.
    const INHERITED_HOME_SENTINEL: &str = "/nonexistent/inherited-home";
    const INHERITED_SHELL_SENTINEL: &str = "/nonexistent/inherited-shell";

    /// Mirror of the production rule: the passwd shell is used verbatim and
    /// only an empty field becomes `/bin/sh`. A shell the image does not ship
    /// is *not* substituted, so this oracle must not probe for one either.
    fn selected_shell(configured: PathBuf) -> PathBuf {
        if configured.as_os_str().is_empty() {
            return PathBuf::from("/bin/sh");
        }
        configured
    }

    #[test]
    fn internal_workload_subprocess_driver() {
        let Ok(case) = std::env::var(SUBPROCESS_CASE) else {
            return;
        };
        if case == "close-fds" {
            let file = fs::File::open("/dev/null").unwrap();
            // The highest descriptor this process may hold. dup2 rejects a
            // target at or above RLIMIT_NOFILE with EBADF, so a fixed number
            // fails before the code under test ever runs wherever the soft
            // limit is lower.
            let high_fd = {
                let mut limit = nix::libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                assert_eq!(
                    unsafe { nix::libc::getrlimit(nix::libc::RLIMIT_NOFILE, &mut limit) },
                    0
                );
                i32::try_from(limit.rlim_cur.saturating_sub(1).min(4096)).unwrap()
            };
            assert_eq!(
                unsafe { nix::libc::dup2(std::os::fd::AsRawFd::as_raw_fd(&file), high_fd) },
                high_fd
            );
            close_inherited_fds().unwrap();
            let high_closed = unsafe { nix::libc::fcntl(high_fd, nix::libc::F_GETFD) } == -1;
            let stdio_open =
                (0..=2).all(|fd| unsafe { nix::libc::fcntl(fd, nix::libc::F_GETFD) } != -1);
            if high_closed && stdio_open {
                println!("fd-boundary-ok");
                std::io::stdout().flush().unwrap();
                exit_without_inherited_handlers(0);
            }
            exit_without_inherited_handlers(1);
        }
        if case == "panic" {
            install_direct_workload_panic_hook();
            panic!("must terminate through the direct-workload panic hook");
        }

        let args = match case.as_str() {
            "shell" => vec![
                INTERNAL_PROGRAM.to_string(),
                session::INTERNAL_SESSION_ARG.to_string(),
                "shell".to_string(),
            ],
            "exec" => vec![
                INTERNAL_PROGRAM.to_string(),
                session::INTERNAL_SESSION_ARG.to_string(),
                "exec".to_string(),
                std::env::var(SUBPROCESS_COMMAND).unwrap(),
            ],
            "sftp" => vec![
                INTERNAL_PROGRAM.to_string(),
                sftp::INTERNAL_SFTP_ARG.to_string(),
            ],
            _ => panic!("unknown subprocess case: {case}"),
        };
        let workload = SshWorkload::from_container_args(&args).unwrap().unwrap();
        let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        BoxliteWorkloadExecutor::new(workload)
            .exec(&spec(&arg_refs, false))
            .unwrap();
        unreachable!("successful workload execution must not return");
    }

    #[test]
    fn shell_workload_enters_root_home_and_uses_login_argv0() {
        let inherited_cwd = tempfile::tempdir().unwrap();
        let (home, shell) = root_record();
        let expected_home = selected_home(home);
        let expected_shell = fs::canonicalize(selected_shell(shell)).unwrap();
        let expected_argv0 = format!("-{}", expected_shell.file_name().unwrap().to_string_lossy());
        let mut child = spawn_subprocess("shell", inherited_cwd.path());

        wait_for_cwd(&mut child, &expected_home);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if matches!(
                fs::read_link(format!("/proc/{}/exe", child.id())),
                Ok(path) if path == expected_shell
            ) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "workload never execed {expected_shell:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"printf '\\036%s\\037' \"$0\"; exit\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let framed = [
            b"\x1e".as_slice(),
            expected_argv0.as_bytes(),
            b"\x1f".as_slice(),
        ]
        .concat();
        assert!(output
            .stdout
            .windows(framed.len())
            .any(|window| window == framed));
    }

    #[test]
    fn exec_workload_preserves_one_command_argument_and_exports_the_account_profile() {
        let inherited_cwd = tempfile::tempdir().unwrap();
        let (home, shell) = root_record();
        let expected_home = selected_home(home);
        let expected_shell = selected_shell(shell);
        let command = r#"printf '\036%s\0%s\0%s\0%s\037' "$PWD" "$HOME" "$SHELL" 'literal spaces ; $(not reparsed)'"#;
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                SUBPROCESS_TEST,
                "--nocapture",
                "--test-threads=1",
            ])
            .env(SUBPROCESS_CASE, "exec")
            .env(SUBPROCESS_COMMAND, command)
            // Values the session must overwrite. Inheriting the runner's own
            // HOME/SHELL would let this pass without the session exporting
            // anything.
            .env("HOME", INHERITED_HOME_SENTINEL)
            .env("SHELL", INHERITED_SHELL_SENTINEL)
            .current_dir(inherited_cwd.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // HOME is exported as the directory actually entered, so it tracks $PWD.
        let expected = format!(
            "\u{1e}{}\0{}\0{}\0literal spaces ; $(not reparsed)\u{1f}",
            expected_home.display(),
            expected_home.display(),
            expected_shell.display()
        );
        assert!(
            output
                .stdout
                .windows(expected.len())
                .any(|window| window == expected.as_bytes()),
            "expected {expected:?} in {:?}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    #[test]
    fn sftp_workload_enters_root_home() {
        let inherited_cwd = tempfile::tempdir().unwrap();
        let expected_home = selected_home(root_record().0);
        let mut child = spawn_subprocess("sftp", inherited_cwd.path());
        wait_for_cwd(&mut child, &expected_home);
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn direct_workloads_close_high_descriptors_but_keep_stdio() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                SUBPROCESS_TEST,
                "--nocapture",
                "--test-threads=1",
            ])
            .env(SUBPROCESS_CASE, "close-fds")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("fd-boundary-ok"));
    }

    #[test]
    fn direct_workload_panics_exit_without_unwinding() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                SUBPROCESS_TEST,
                "--nocapture",
                "--test-threads=1",
            ])
            .env(SUBPROCESS_CASE, "panic")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(101));
        assert!(String::from_utf8_lossy(&output.stderr)
            .contains("[ssh-workload] internal workload panicked"));
    }
}
