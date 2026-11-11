use super::{FileLockManager, LockGuard, LockId, LockManager, ReadLockGuard};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::time::{sleep, timeout};

const CHILD_MODE: &str = "BOXLITE_LOCK_TEST_MODE";
const CHILD_ROOT: &str = "BOXLITE_LOCK_TEST_ROOT";
const CHILD_ID: &str = "BOXLITE_LOCK_TEST_ID";
const DEADLINE: Duration = Duration::from_secs(10);

// std Child does not reap on drop; also clean up on assertion failures/timeouts.
struct LockChild(Child);

impl Drop for LockChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl LockChild {
    async fn wait_for_success(&mut self) {
        let status = timeout(DEADLINE, async {
            loop {
                if let Some(status) = self.0.try_wait().unwrap() {
                    break status;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("lock child did not exit");
        assert!(status.success(), "lock child failed: {status}");
    }
}

fn exit_on_command(control: &mut std::os::unix::net::UnixStream) -> ! {
    let mut command = [0];
    control.read_exact(&mut command).unwrap();
    assert_eq!(command, *b"X");
    // Skip guard destructors: release must come from kernel descriptor cleanup.
    std::process::exit(0);
}

fn run_child(root: &Path, mode: &str) -> ! {
    let manager = FileLockManager::open(root.join("locks")).unwrap();
    let id = LockId(std::env::var(CHILD_ID).unwrap().parse().unwrap());
    let owner = manager.retrieve(id).unwrap();
    let peer = manager.retrieve(id).unwrap();
    let mut control = std::os::unix::net::UnixStream::connect(root.join("control.sock")).unwrap();
    control.set_read_timeout(Some(DEADLINE)).unwrap();
    control.set_write_timeout(Some(DEADLINE)).unwrap();

    match mode {
        "reader" => {
            let _guard = ReadLockGuard::try_new(owner.as_ref()).expect("cross-process shared read");
            control.write_all(b"R").unwrap();
            exit_on_command(&mut control);
        }
        "writer" => {
            assert!(ReadLockGuard::try_new(owner.as_ref()).is_none());
            assert!(LockGuard::try_new(peer.as_ref()).is_none());
            control.write_all(b"B").unwrap();
            let mut command = [0];
            control.read_exact(&mut command).unwrap();
            assert_eq!(command, *b"A");
            let _guard = LockGuard::try_new(owner.as_ref()).expect("parent released writer");
            control.write_all(b"W").unwrap();
            exit_on_command(&mut control);
        }
        _ => panic!("unknown lock child mode: {mode}"),
    }
}

#[tokio::test]
async fn file_read_write_across_processes() {
    if let Ok(mode) = std::env::var(CHILD_MODE) {
        run_child(Path::new(&std::env::var_os(CHILD_ROOT).unwrap()), &mode);
    }

    let temp = tempfile::tempdir().unwrap();
    let manager = FileLockManager::new(temp.path().join("locks")).unwrap();
    let id = manager.allocate().unwrap();
    let owner = manager.retrieve(id).unwrap();
    let probe = manager.retrieve(id).unwrap();
    let listener = UnixListener::bind(temp.path().join("control.sock")).unwrap();

    timeout(DEADLINE * 3, async {
        for mode in ["reader", "writer"] {
            let held_read = (mode == "reader").then(|| ReadLockGuard::new(owner.as_ref()));
            let held_write = (mode == "writer").then(|| LockGuard::new(owner.as_ref()));
            let mut child = LockChild(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "lock::process_tests::file_read_write_across_processes",
                        "--nocapture",
                    ])
                    .env(CHILD_MODE, mode)
                    .env(CHILD_ROOT, temp.path())
                    .env(CHILD_ID, id.0.to_string())
                    .spawn()
                    .unwrap(),
            );
            let (mut control, _) = listener.accept().await.unwrap();
            let expected = if mode == "reader" { b'R' } else { b'B' };
            assert_eq!(control.read_u8().await.unwrap(), expected);
            drop(held_read);
            drop(held_write);

            if mode == "reader" {
                assert!(
                    LockGuard::try_new(probe.as_ref()).is_none(),
                    "child still holds a reader"
                );
                assert!(
                    ReadLockGuard::try_new(probe.as_ref()).is_some(),
                    "readers coexist"
                );
            } else {
                control.write_all(b"A").await.unwrap();
                assert_eq!(control.read_u8().await.unwrap(), b'W');
                assert!(ReadLockGuard::try_new(probe.as_ref()).is_none());
                assert!(LockGuard::try_new(probe.as_ref()).is_none());
            }
            control.write_all(b"X").await.unwrap();
            child.wait_for_success().await;
            assert!(
                ReadLockGuard::try_new(probe.as_ref()).is_some(),
                "exit releases to readers"
            );
            assert!(
                LockGuard::try_new(probe.as_ref()).is_some(),
                "exit releases to writers"
            );
        }
    })
    .await
    .expect("cross-process lock scenario timed out");
}
