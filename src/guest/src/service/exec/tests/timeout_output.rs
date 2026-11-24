use super::*;
use crate::reaper::{reap_fence, reap_test_guard, ExitSlot};
use crate::service::exec::exec_handle::ExitStatus;
use crate::service::exec::process_instance::{ProcessGroup, ProcessInstance};
use crate::service::exec::timeout::TimeoutTarget;
use boxlite_shared::exec_output;
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

struct Descendant(ProcessInstance, Pid);

impl Descendant {
    fn is_running(&self) -> bool {
        self.0.is_current()
            && procfs::process::Process::new(self.1.as_raw())
                .and_then(|process| process.stat())
                .is_ok_and(|stat| !matches!(stat.state, 'Z' | 'X'))
    }
}

impl Drop for Descendant {
    fn drop(&mut self) {
        let _ = self.0.signal(Signal::SIGKILL, false);
    }
}

async fn exited_leader(escaped_group: bool) -> (ExecutionState, TimeoutTarget, Descendant) {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("child.pid");
    let (state, target, descendant) = {
        let _fence = reap_fence();
        let sleeper = if escaped_group {
            "setsid sleep 60"
        } else {
            "sleep 60"
        };
        let mut leader = Command::new("/bin/sh")
            .args([
                "-c",
                &format!(
                    "{sleeper} & echo $! > \"$1\"; printf stdout-data; printf stderr-data >&2",
                ),
                "cutoff-test",
            ])
            .arg(&pid_file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = Pid::from_raw(leader.id() as i32);
        let target = TimeoutTarget::from_spawn(
            ProcessInstance::capture(pid),
            escaped_group.then(|| ProcessGroup::capture(pid)).flatten(),
        );
        let handle = ExecHandle::new(
            pid,
            leader.stdin.take().unwrap().into(),
            leader.stdout.take().unwrap().into(),
            Some(leader.stderr.take().unwrap().into()),
        )
        .unwrap();
        assert!(leader.wait().unwrap().success());
        let child_pid = std::fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let descendant = Descendant(
            ProcessInstance::capture(Pid::from_raw(child_pid)).unwrap(),
            Pid::from_raw(child_pid),
        );
        let state = ExecutionState::new_for_test(handle, ExitSlot::settled(ExitStatus::Code(0)));
        (state, target, descendant)
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.retained_output_bytes().await != b"stdout-datastderr-data".len() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("both real pipe readers must buffer data before the deadline test");
    if escaped_group {
        tokio::time::timeout(Duration::from_secs(2), async {
            while nix::unistd::getpgid(Some(descendant.1)).ok() != Some(descendant.1) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("descendant must leave the original group before arming the deadline");
    }
    assert!(
        descendant.is_running(),
        "descendant must still hold the pipes"
    );
    (state, target, descendant)
}

async fn arm_timeout(state: &ExecutionState, target: TimeoutTarget, duration: Duration) {
    state.start_timeout(target, "cutoff".into(), duration).await;
}

async fn assert_buffered_stream_ends(mut receiver: mpsc::Receiver<Result<ExecOutput, Status>>) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_end = false;
    let mut stderr_end = false;
    tokio::time::timeout(Duration::from_secs(4), async {
        while let Some(event) = receiver.recv().await {
            match event.unwrap().event.unwrap() {
                exec_output::Event::Stdout(event) => {
                    assert!(!stdout_end, "stdout data cannot follow its end frame");
                    if let Some(total) = event.total_bytes {
                        assert_eq!(total, stdout.len() as u64);
                        stdout_end = true;
                    } else {
                        stdout.extend(event.data);
                    }
                }
                exec_output::Event::Stderr(event) => {
                    assert!(!stderr_end, "stderr data cannot follow its end frame");
                    if let Some(total) = event.total_bytes {
                        assert_eq!(total, stderr.len() as u64);
                        stderr_end = true;
                    } else {
                        stderr.extend(event.data);
                    }
                }
            }
        }
    })
    .await
    .expect("Guest output must end while a descendant still holds both pipes");
    assert_eq!(stdout, b"stdout-data");
    assert_eq!(stderr, b"stderr-data");
    assert!(
        stdout_end && stderr_end,
        "both streams need their existing end frames"
    );
}

#[tokio::test]
async fn guest_cutoff_survives_leader_exit_without_group_signaling() {
    let _guard = reap_test_guard().await;
    let (state, target, descendant) = exited_leader(false).await;
    arm_timeout(&state, target, Duration::from_millis(20)).await;
    state.finish_timeout_task().await;
    let output = state.attach("cutoff").await.unwrap();
    assert_buffered_stream_ends(output).await;
    assert!(
        descendant.is_running(),
        "cutoff must not rely on terminating the descendant"
    );
    assert_eq!(state.wait_exit("cutoff").await.exit_code, 0);
    let summary = state.wait_terminal_output_summary().await;
    assert!(summary.truncated);
    assert!(summary.reader_failure.is_none());
    assert_buffered_stream_ends(state.attach_retained("cutoff").await.unwrap()).await;
    assert_eq!(state.sealed_terminal_output_summary().await, Some(summary));
    state.release_resources().await;
}

#[tokio::test]
async fn guest_cutoff_runs_when_term_finds_no_live_leader() {
    let _guard = reap_test_guard().await;
    let (state, target, descendant) = exited_leader(false).await;
    arm_timeout(&state, target, Duration::from_millis(20)).await;
    assert_buffered_stream_ends(state.attach("cutoff").await.unwrap()).await;
    assert!(descendant.is_running());
    assert_eq!(state.wait_exit("cutoff").await.exit_code, 0);
    state.release_resources().await;
}

#[tokio::test]
async fn guest_cutoff_survives_an_empty_original_group() {
    let _guard = reap_test_guard().await;
    let (state, target, descendant) = exited_leader(true).await;
    arm_timeout(&state, target, Duration::from_millis(20)).await;
    state.finish_timeout_task().await;
    assert_buffered_stream_ends(state.attach("cutoff").await.unwrap()).await;
    assert!(descendant.is_running());
    state.release_resources().await;
}

#[tokio::test]
async fn guest_cutoff_terminal_observer_retains_exited_leader() {
    let _guard = reap_test_guard().await;
    let (state, target, descendant) = exited_leader(false).await;
    arm_timeout(&state, target, Duration::from_millis(20)).await;
    let registry = crate::service::exec::registry::ExecutionRegistry::new();
    assert!(registry.register("cutoff".into(), state.clone()).await);
    registry.observe_terminal("cutoff".into(), state.clone());
    assert_buffered_stream_ends(state.attach("cutoff").await.unwrap()).await;
    let snapshot = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Some(snapshot) = registry.terminal_snapshot("cutoff").await {
                break snapshot;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cutoff must let the registry retain terminal output");
    assert_eq!(snapshot.exit.exit_code, 0);
    assert!(snapshot.output.truncated);
    assert!(descendant.is_running());
    registry.release_ephemeral("cutoff").await;
}

fn held_pipes() -> (ExecutionState, std::os::fd::OwnedFd, std::os::fd::OwnedFd) {
    let (_stdin_peer, stdin) = nix::unistd::pipe().unwrap();
    let (stdout, stdout_peer) = nix::unistd::pipe().unwrap();
    let (stderr, stderr_peer) = nix::unistd::pipe().unwrap();
    let state = ExecutionState::new_for_test(
        ExecHandle::new(Pid::from_raw(30_200), stdin, stdout, Some(stderr)).unwrap(),
        ExitSlot::settled(ExitStatus::Code(0)),
    );
    (state, stdout_peer, stderr_peer)
}

#[tokio::test]
async fn guest_cutoff_release_closes_readers_before_late_timeout_registration() {
    let (state, stdout_peer, stderr_peer) = held_pipes();
    assert!(state.release_resources().await);
    arm_timeout(
        &state,
        TimeoutTarget::from_spawn(None, None),
        Duration::from_secs(3600),
    )
    .await;
    assert!(state.inner.lock().await.timeout_task.is_none());
    assert!(
        tokio::time::timeout(Duration::from_secs(1), state.wait_terminal_output_summary())
            .await
            .expect("release must wake terminal output waiters")
            .truncated
    );
    assert_eq!(
        nix::unistd::write(&stdout_peer, b"x"),
        Err(nix::errno::Errno::EPIPE)
    );
    assert_eq!(
        nix::unistd::write(&stderr_peer, b"x"),
        Err(nix::errno::Errno::EPIPE)
    );
    assert!(!state.release_resources().await);
}

#[tokio::test]
async fn guest_cutoff_release_closes_readers_with_registered_timeout() {
    let (state, stdout_peer, stderr_peer) = held_pipes();
    arm_timeout(
        &state,
        TimeoutTarget::from_spawn(None, None),
        Duration::from_secs(3600),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(1), state.release_resources())
        .await
        .expect("release cannot wait for the execution deadline");
    assert!(state.inner.lock().await.timeout_task.is_none());
    assert!(
        tokio::time::timeout(Duration::from_secs(1), state.wait_terminal_output_summary())
            .await
            .expect("release must wake terminal output waiters")
            .truncated
    );
    assert_eq!(
        nix::unistd::write(&stdout_peer, b"x"),
        Err(nix::errno::Errno::EPIPE)
    );
    assert_eq!(
        nix::unistd::write(&stderr_peer, b"x"),
        Err(nix::errno::Errno::EPIPE)
    );
}
