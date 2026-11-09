//! Preserve init's pre-start terminal setup and failure cleanup.

use super::*;
use libcontainer::container::{ContainerStatus, State};
use nix::pty::{openpty, Winsize};
use nix::sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg};
use std::os::fd::{AsRawFd, OwnedFd};

fn container_with_stdio(root: &Path, pid: i32, master: OwnedFd) -> Container {
    let mut container = Container::for_unit_test("pty-init", root.into(), root.join("bundle"));
    std::fs::create_dir(root.join("pty-init")).unwrap();
    State::new(
        "pty-init",
        ContainerStatus::Created,
        Some(pid),
        root.join("bundle"),
    )
    .save(&root.join("pty-init"))
    .unwrap();
    container.stdio = ContainerStdio::pty(master);
    container
}

#[tokio::test]
async fn pty_init_initializes_size_and_preserves_modes() {
    let root = tempfile::tempdir().unwrap();
    let pty = openpty(None, None).unwrap();
    let mut modes = tcgetattr(&pty.slave).unwrap();
    cfmakeraw(&mut modes);
    tcsetattr(&pty.slave, SetArg::TCSANOW, &modes).unwrap();
    let mut container = container_with_stdio(root.path(), std::process::id() as i32, pty.master);
    let handle = container.take_init_exec_handle().unwrap().unwrap();
    let mut size = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: the owned slave remains open and size is a valid output buffer.
    assert_eq!(
        unsafe { nix::libc::ioctl(pty.slave.as_raw_fd(), nix::libc::TIOCGWINSZ, &mut size) },
        0
    );
    assert_eq!(
        size,
        Winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0
        }
    );
    assert_eq!(
        tcgetattr(&pty.slave).unwrap(),
        modes,
        "empty init modes must preserve termios"
    );
    assert!(handle.pty_controller().is_some());
    assert!(container.take_init_exec_handle().unwrap().is_none());
}

#[test]
fn pty_init_initialization_failure_terminates_child() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let child = Child(
        std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap(),
    );
    let pid = nix::unistd::Pid::from_raw(child.0.id() as i32);
    let root = tempfile::tempdir().unwrap();
    let master = std::fs::File::open("/dev/null").unwrap().into();
    let mut container = container_with_stdio(root.path(), pid.as_raw(), master);
    let error = container
        .take_init_exec_handle()
        .err()
        .expect("nonterminal must fail");
    assert!(
        error
            .to_string()
            .contains("Failed to set PTY window size (24x80)"),
        "{error}"
    );
    assert_eq!(
        nix::sys::signal::kill(pid, None),
        Err(nix::errno::Errno::ESRCH)
    );
    assert!(container.take_init_exec_handle().unwrap().is_none());
}
