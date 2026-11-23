use std::io::{BufRead, BufReader};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use nix::errno::Errno;
use nix::libc;
use nix::sys::signal::Signal;
use nix::unistd::Pid;

use super::{start_timeout_watcher, TimeoutTarget};
use crate::reaper::{reap_fence, reap_test_guard};
use crate::service::exec::process_instance::{ProcessGroup, ProcessInstance};

// Probe an owned group: a pidfd for a non-leader cannot identify a process group.
fn supports_group_signaling() -> bool {
    let _fence = reap_fence();
    let mut leader = Command::new("/bin/sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .expect("spawn the capability probe group");
    // SAFETY: pidfd_open takes a live PID and returns a new owned descriptor.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, leader.id(), 0) };
    let result = if fd < 0 {
        Err(Errno::last())
    } else {
        // SAFETY: pidfd_open returned a new, valid descriptor.
        let group = ProcessGroup::from(unsafe { OwnedFd::from_raw_fd(fd as i32) });
        group.signal(0)
    };
    leader.kill().expect("stop the capability probe group");
    leader.wait().expect("reap the capability probe group");
    match result {
        Ok(true) => true,
        Err(Errno::EINVAL | Errno::ENOSYS) => {
            eprintln!("skipping timed-group test: kernel lacks pidfd group signaling");
            false
        }
        result => panic!("probe pidfd group signaling: {result:?}"),
    }
}

struct KillOnDrop(ProcessInstance);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.signal(Signal::SIGKILL, false);
    }
}

#[tokio::test]
async fn timed_group_signal_reaches_descendant_after_leader_reaped() {
    let _guard = reap_test_guard().await;
    if !supports_group_signaling() {
        return;
    }
    let (target, descendant, descendant_pid) = {
        let _fence = reap_fence();
        let mut leader = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; sleep 30 & echo $!; read hold; exit 0"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .expect("start a private process group");
        let pid = Pid::from_raw(leader.id() as i32);
        let target = TimeoutTarget::new(ProcessInstance::capture(pid));
        let mut line = String::new();
        BufReader::new(leader.stdout.take().expect("shell stdout"))
            .read_line(&mut line)
            .expect("read the descendant PID");
        let descendant_pid = Pid::from_raw(line.trim().parse().expect("valid descendant PID"));
        let descendant = KillOnDrop(
            ProcessInstance::capture(descendant_pid).expect("capture descendant identity"),
        );

        drop(leader.stdin.take());
        assert!(leader.wait().expect("reap shell").success());
        (target, descendant, descendant_pid)
    };

    assert!(
        descendant.0.is_current(),
        "descendant exited before the test"
    );
    assert!(
        target
            .signal_if_live(Signal::SIGKILL)
            .expect("signal the timed workload"),
        "timed group signal missed a live descendant after the leader was reaped"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while procfs::process::Process::new(descendant_pid.as_raw())
            .and_then(|process| process.stat())
            .is_ok_and(|stat| stat.state != 'Z')
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("descendant must exit after SIGKILL");
}

#[tokio::test]
async fn detached_timeout_watcher_releases_empty_group_before_deadline() {
    let _guard = reap_test_guard().await;
    if !supports_group_signaling() {
        return;
    }
    let (target, mut member) = {
        let _fence = reap_fence();
        let mut leader = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn group leader");
        let pid = Pid::from_raw(leader.id() as i32);
        let member = Command::new("/bin/sleep")
            .arg("30")
            .process_group(pid.as_raw())
            .spawn()
            .expect("spawn group member");
        let target = TimeoutTarget::new(ProcessInstance::capture(pid));
        leader.kill().expect("stop the group leader");
        leader.wait().expect("reap the group leader");
        (target, member)
    };

    let timeout = start_timeout_watcher(
        target,
        "detached".to_owned(),
        Duration::from_secs(30),
        crate::service::exec::output::OutputManager::new(None, None),
    );
    let retained_target = Arc::downgrade(&timeout.target);
    timeout.finish().await;
    let still_watching = retained_target.upgrade().is_some();

    {
        let _fence = reap_fence();
        member.kill().expect("stop the remaining group member");
        member.wait().expect("reap the remaining group member");
    }
    assert!(
        still_watching,
        "watcher must retain a group with live members"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while retained_target.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("detached watcher must release an empty group before its deadline");
}
