//! Each policy check runs in a separate process. PID 1 checks use a new user
//! and PID namespace: reboot terminates that namespace, never the host.

use super::*;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn child_command(mode: &str, init: bool) -> Command {
    let executable = std::env::current_exe().unwrap();
    let mut command = if init {
        let mut command = Command::new("unshare");
        command.args([
            "--user",
            "--map-root-user",
            "--pid",
            "--fork",
            "--kill-child=KILL",
        ]);
        command.arg(&executable);
        command
    } else {
        Command::new(&executable)
    };
    command
        .args([
            "--exact",
            "lifecycle::tests::child",
            "--ignored",
            "--nocapture",
        ])
        .env("BOXLITE_LIFECYCLE_TEST", mode)
        .stdout(Stdio::piped());
    command
}

fn run_child(mode: &str, init: bool, failed_stderr: bool) -> Output {
    let mut command = child_command(mode, init);
    if failed_stderr {
        command.stderr(
            std::fs::OpenOptions::new()
                .write(true)
                .open("/dev/full")
                .unwrap(),
        );
    } else {
        command.stderr(Stdio::piped());
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!("lifecycle child hung: {output:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

fn assert_restarted(output: &Output) {
    // util-linux may propagate SIGHUP as a signal or a shell-style status.
    assert!(
        output.status.signal() == Some(libc::SIGHUP) || output.status.code() == Some(129),
        "{output:?}"
    );
}

#[test]
fn ordinary_processes_keep_exit_and_panic_status() {
    assert_eq!(run_child("exit", false, false).status.code(), Some(7));
    let output = run_child("panic", false, false);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(!String::from_utf8_lossy(&output.stderr).contains("restarting"));
}

#[test]
fn init_restarts_on_return_and_panic_even_with_failed_stderr() {
    for (mode, failed_stderr) in [
        ("exit", false),
        ("panic", false),
        ("panic", true),
        ("tokio-panic", false),
    ] {
        assert_restarted(&run_child(mode, true, failed_stderr));
    }
}

#[test]
fn fork_children_drop_the_inherited_init_panic_policy() {
    let output = run_child("fork", true, false);
    assert_restarted(&output);
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("CHILD_EXIT_NORMAL"),
        "{output:?}"
    );
}

#[test]
fn failed_reset_keeps_init_alive_for_host_cleanup() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let mut child = child_command("reset-denied", true)
        .stderr(log.reopen().unwrap())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let diagnostics = loop {
        let diagnostics = std::fs::read_to_string(log.path()).unwrap();
        if diagnostics.contains("reset failed:") {
            break diagnostics;
        }
        if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("init did not reach failed-reset handling: {diagnostics}");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let status = child.try_wait().unwrap();
    let _ = child.kill();
    child.wait().unwrap();
    assert!(status.is_none(), "init exited: {status:?}; {diagnostics}");
    assert!(
        diagnostics.contains("waiting for host cleanup"),
        "{diagnostics}"
    );
}

#[test]
#[ignore = "subprocess entry for the lifecycle tests"]
fn child() {
    crate::test_syscalls::deny(libc::SYS_sync);
    install_panic_hook();
    match std::env::var("BOXLITE_LIFECYCLE_TEST").unwrap().as_str() {
        "exit" => exit(7),
        "reset-denied" => {
            crate::test_syscalls::deny(libc::SYS_reboot);
            exit(7);
        }
        "panic" => panic!("lifecycle panic probe"),
        "tokio-panic" => {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let _ = tokio::spawn(async { panic!("Tokio panic probe") }).await;
            });
            std::process::exit(99);
        }
        "fork" => {
            use nix::{
                sched::{unshare, CloneFlags},
                sys::wait::{waitpid, WaitStatus},
                unistd::{fork, ForkResult},
            };
            // The helper has no runtime or concurrent test work. The first
            // child resets its inherited hook exactly as the zygote does.
            match unsafe { fork() }.unwrap() {
                ForkResult::Child => {
                    install_panic_hook();
                    unshare(CloneFlags::CLONE_NEWPID).unwrap();
                    match unsafe { fork() }.unwrap() {
                        ForkResult::Child => {
                            assert_eq!(getpid().as_raw(), 1);
                            panic!("container init panic probe");
                        }
                        ForkResult::Parent { child } => {
                            let status = waitpid(child, None).unwrap();
                            std::process::exit(if status == WaitStatus::Exited(child, 1) {
                                0
                            } else {
                                99
                            });
                        }
                    }
                }
                ForkResult::Parent { child } => {
                    assert_eq!(waitpid(child, None).unwrap(), WaitStatus::Exited(child, 0));
                    println!("CHILD_EXIT_NORMAL");
                    exit(0);
                }
            }
        }
        mode => panic!("unknown lifecycle mode: {mode}"),
    }
}
