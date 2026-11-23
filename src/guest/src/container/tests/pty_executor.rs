//! Unprivileged checks of the executor boundary, independent of container setup.

use crate::container::pty::PtyExecutor;
use crate::service::exec::exec_handle::{PtyConfig, PtyMode};
use libcontainer::oci_spec::runtime::{ProcessBuilder, Spec, SpecBuilder};
use libcontainer::workload::{
    default::DefaultExecutor, Executor, ExecutorError, ExecutorSetEnvsError,
    ExecutorValidationError,
};
use nix::pty::{openpty, Winsize};
use nix::sys::termios::{tcgetattr, InputFlags, LocalFlags, SpecialCharacterIndices};
use std::collections::HashMap;
use std::io::{Read, Seek};
use std::os::fd::AsRawFd;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CHILD_ENV: &str = "BOXLITE_PTY_EXECUTOR_CHILD";

fn config() -> PtyConfig {
    PtyConfig {
        rows: 43,
        cols: 137,
        x_pixels: 640,
        y_pixels: 480,
        modes: vec![
            PtyMode {
                opcode: 51,
                value: 0,
            }, // ICANON
            PtyMode {
                opcode: 53,
                value: 0,
            }, // ECHO
            PtyMode {
                opcode: 36,
                value: 0,
            }, // ICRNL
            PtyMode {
                opcode: 1,
                value: 7,
            }, // VINTR
        ],
    }
}

// Re-enter only this test with a private stdin, keeping the harness's fd 0 intact.
// Returning normally in observer cases also lets LLVM flush subprocess coverage.
fn in_child(terminal: bool, check: impl FnOnce()) -> String {
    if std::env::var_os(CHILD_ENV).is_some() {
        check();
        return String::new();
    }
    let pty = terminal.then(|| openpty(None, None).unwrap());
    let stdin = match &pty {
        Some(pty) => Stdio::from(pty.slave.try_clone().unwrap()),
        None => Stdio::null(),
    };
    let mut log = tempfile::tempfile().unwrap();
    let mut child = super::Child(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::thread::current().name().unwrap(),
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .stdin(stdin)
            .stdout(log.try_clone().unwrap())
            .stderr(log.try_clone().unwrap())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "PTY executor child timed out");
        std::thread::sleep(Duration::from_millis(10));
    };
    log.rewind().unwrap();
    let mut output = String::new();
    log.read_to_string(&mut output).unwrap();
    assert!(status.success(), "PTY executor child failed:\n{output}");
    output
}

#[test]
fn pty_executor_configures_terminal_before_real_workload() {
    let output = in_child(true, || {
        let spec = SpecBuilder::default()
            .process(
                ProcessBuilder::default()
                    .args(vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "stty size; stty -a".into(),
                    ])
                    .build()
                    .unwrap(),
            )
            .build()
            .unwrap();
        PtyExecutor {
            inner: Box::new(DefaultExecutor {}),
            config: Some(config()),
        }
        .exec(&spec)
        .unwrap();
        panic!("DefaultExecutor must replace the child with the workload");
    });
    assert!(
        output.lines().any(|line| line == "43 137"),
        "workload saw wrong dimensions: {output}"
    );
    for mode in ["-icanon", "-echo", "-icrnl"] {
        assert!(
            output.split_whitespace().any(|token| token == mode),
            "workload did not see {mode}: {output}"
        );
    }
    assert!(
        output.contains("intr = ^G"),
        "workload saw wrong VINTR: {output}"
    );
}

#[derive(Clone, Default)]
struct Observer {
    calls: Arc<Mutex<Vec<String>>>,
    inspect_terminal: bool,
}

impl Executor for Observer {
    fn exec(&self, _spec: &Spec) -> Result<(), ExecutorError> {
        self.calls.lock().unwrap().push("exec".into());
        if self.inspect_terminal {
            let stdin = std::io::stdin();
            let mut size = Winsize {
                ws_row: 0,
                ws_col: 0,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: stdin is live and size is a correctly sized writable buffer.
            assert_eq!(
                unsafe { nix::libc::ioctl(stdin.as_raw_fd(), nix::libc::TIOCGWINSZ, &mut size) },
                0
            );
            assert_eq!(
                size,
                Winsize {
                    ws_row: 43,
                    ws_col: 137,
                    ws_xpixel: 640,
                    ws_ypixel: 480
                }
            );
            let attrs = tcgetattr(&stdin).unwrap();
            assert!(!attrs
                .local_flags
                .intersects(LocalFlags::ICANON | LocalFlags::ECHO));
            assert!(!attrs.input_flags.contains(InputFlags::ICRNL));
            assert_eq!(
                attrs.control_chars[SpecialCharacterIndices::VINTR as usize],
                7
            );
        }
        Err(ExecutorError::Other("workload error".into()))
    }

    fn validate(&self, spec: &Spec) -> Result<(), ExecutorValidationError> {
        assert_eq!(spec.hostname().as_deref(), Some("pty-probe"));
        self.calls.lock().unwrap().push("validate".into());
        Err(ExecutorValidationError::ArgValidationError(
            "validation error".into(),
        ))
    }

    fn setup_envs(&self, envs: HashMap<String, String>) -> Result<(), ExecutorSetEnvsError> {
        assert_eq!(envs, HashMap::from([("PTY_PROBE".into(), "value".into())]));
        self.calls.lock().unwrap().push("envs".into());
        Err(ExecutorSetEnvsError::Other("environment error".into()))
    }
}

#[test]
fn pty_executor_initializes_before_delegating_and_preserves_workload_error() {
    in_child(true, || {
        let observer = Observer {
            inspect_terminal: true,
            ..Observer::default()
        };
        let executor = PtyExecutor {
            inner: Box::new(observer.clone()),
            config: Some(config()),
        };
        assert!(
            matches!(executor.exec(&Spec::default()), Err(ExecutorError::Other(error)) if error == "workload error")
        );
        assert_eq!(*observer.calls.lock().unwrap(), ["exec"]);
    });
}

#[test]
fn pty_executor_without_config_accepts_nonterminal_stdin() {
    in_child(false, || {
        let observer = Observer::default();
        let executor = PtyExecutor {
            inner: Box::new(observer.clone()),
            config: None,
        };
        assert!(
            matches!(executor.exec(&Spec::default()), Err(ExecutorError::Other(error)) if error == "workload error")
        );
        assert_eq!(*observer.calls.lock().unwrap(), ["exec"]);
    });
}

#[test]
fn pty_executor_initialization_failure_prevents_workload_execution() {
    in_child(false, || {
        let observer = Observer::default();
        let executor = PtyExecutor {
            inner: Box::new(observer.clone()),
            config: Some(config()),
        };
        let Err(ExecutorError::Execution(error)) = executor.exec(&Spec::default()) else {
            panic!("a configured nonterminal must fail initialization");
        };
        assert!(
            error
                .to_string()
                .contains("Failed to set PTY window size (43x137)"),
            "{error}"
        );
        assert!(observer.calls.lock().unwrap().is_empty());
    });
}

#[test]
fn pty_executor_delegates_validation_and_environment_errors() {
    let observer = Observer::default();
    let executor = PtyExecutor {
        inner: Box::new(observer.clone()),
        config: Some(config()),
    };
    let spec = SpecBuilder::default()
        .hostname("pty-probe")
        .build()
        .unwrap();
    assert!(
        matches!(executor.validate(&spec), Err(ExecutorValidationError::ArgValidationError(error)) if error == "validation error")
    );
    assert!(
        matches!(executor.setup_envs(HashMap::from([("PTY_PROBE".into(), "value".into())])), Err(ExecutorSetEnvsError::Other(error)) if error == "environment error")
    );
    assert_eq!(*observer.calls.lock().unwrap(), ["validate", "envs"]);
}
