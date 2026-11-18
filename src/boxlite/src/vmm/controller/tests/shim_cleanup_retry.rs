use super::*;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn stop_retry_reaches_a_reparented_descendant() {
    let dir = tempfile::tempdir().unwrap();
    let layout = BoxFilesystemLayout::new(dir.path().into(), Default::default(), false);
    let box_id = crate::runtime::id::BoxIDMint::mint();
    let mut launcher = Command::new("sh")
        .args(["-c", "sleep 60 & echo $!; wait"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(launcher.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let descendant = line.trim().parse::<u32>().unwrap();

    struct KillOnDrop(u32);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            if crate::util::is_process_alive(self.0) {
                unsafe { libc::kill(self.0 as i32, libc::SIGKILL) };
            }
        }
    }
    let _cleanup = KillOnDrop(descendant);
    let launcher_pid = launcher.id();
    // Model an interrupted stop after publication and launcher exit.
    PendingShimCleanup::save(&layout, ShimProcessTree::capture(launcher_pid)).unwrap();
    launcher.kill().unwrap();
    launcher.wait().unwrap();
    assert!(crate::util::is_process_alive(descendant));

    let mut retry = ShimHandler::from_pid(launcher_pid, box_id, &layout);
    retry.stop().unwrap();
    assert!(
        !crate::util::is_process_alive(descendant),
        "retry left the recorded descendant alive after launcher exit"
    );
    assert!(!PendingShimCleanup::path(&layout).exists());
}
