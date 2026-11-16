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

static INTERRUPTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

extern "C" fn record_interruption(_: libc::c_int) {
    INTERRUPTIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

fn run_interrupted_child(root: &Path, read: bool) -> ! {
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    let manager = FileLockManager::open(root.join("locks")).unwrap();
    let id = LockId(std::env::var(CHILD_ID).unwrap().parse().unwrap());
    let owner = manager.retrieve(id).unwrap();
    let mut control = std::os::unix::net::UnixStream::connect(root.join("control.sock")).unwrap();
    control.set_read_timeout(Some(DEADLINE)).unwrap();
    control.set_write_timeout(Some(DEADLINE)).unwrap();

    // This disposition exists only in the reexecuted child, never the test runner.
    let acquisition_thread = unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = record_interruption as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        action.sa_flags = 0; // Do not restart an interrupted flock automatically.
        assert_eq!(
            libc::sigaction(libc::SIGUSR1, &action, std::ptr::null_mut()),
            0
        );
        libc::pthread_self()
    };
    let mut signal_control = control.try_clone().unwrap();
    std::thread::scope(|scope| {
        let signals = scope.spawn(move || {
            for delivered in 1..=3 {
                // Space deliveries so the acquisition thread can enter flock.
                std::thread::sleep(Duration::from_millis(20));
                // SAFETY: the scoped acquisition thread stays alive until this join.
                assert_eq!(
                    unsafe { libc::pthread_kill(acquisition_thread, libc::SIGUSR1) },
                    0
                );
                let deadline = Instant::now() + DEADLINE;
                while INTERRUPTIONS.load(Ordering::Relaxed) < delivered {
                    assert!(Instant::now() < deadline, "signal was not delivered");
                    std::thread::yield_now();
                }
            }
            signal_control.write_all(b"I").unwrap();
        });
        let _reader = read.then(|| ReadLockGuard::new(owner.as_ref()));
        let _writer = (!read).then(|| LockGuard::new(owner.as_ref()));
        signals.join().unwrap();
        control.write_all(b"A").unwrap();
        exit_on_command(&mut control);
    });
    unreachable!();
}

async fn blocking_lock_retries_eintr(read: bool) {
    if std::env::var(CHILD_MODE).as_deref() == Ok("interrupted") {
        run_interrupted_child(Path::new(&std::env::var_os(CHILD_ROOT).unwrap()), read);
    }

    let temp = tempfile::tempdir().unwrap();
    let manager = FileLockManager::new(temp.path().join("locks")).unwrap();
    let id = manager.allocate().unwrap();
    let owner = manager.retrieve(id).unwrap();
    let probe = manager.retrieve(id).unwrap();
    let held = LockGuard::new(owner.as_ref());
    let listener = UnixListener::bind(temp.path().join("control.sock")).unwrap();
    let test = if read {
        "lock::process_tests::file_blocking_read_retries_eintr"
    } else {
        "lock::process_tests::file_blocking_write_retries_eintr"
    };
    let mut child = LockChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env(CHILD_MODE, "interrupted")
            .env(CHILD_ROOT, temp.path())
            .env(CHILD_ID, id.0.to_string())
            .spawn()
            .unwrap(),
    );
    timeout(DEADLINE, async {
        let (mut control, _) = listener.accept().await.unwrap();
        assert_eq!(control.read_u8().await.unwrap(), b'I');
        assert!(
            timeout(Duration::from_millis(100), control.read_u8())
                .await
                .is_err(),
            "interrupted waiter must not acquire before release"
        );
        drop(held);
        assert_eq!(control.read_u8().await.unwrap(), b'A');
        assert!(LockGuard::try_new(probe.as_ref()).is_none());
        let concurrent_read = ReadLockGuard::try_new(probe.as_ref());
        assert_eq!(concurrent_read.is_some(), read, "wrong acquisition mode");
        drop(concurrent_read);
        control.write_all(b"X").await.unwrap();
        child.wait_for_success().await;
    })
    .await
    .expect("interrupted lock scenario timed out");
}

#[tokio::test]
async fn file_blocking_read_retries_eintr() {
    blocking_lock_retries_eintr(true).await;
}

#[tokio::test]
async fn file_blocking_write_retries_eintr() {
    blocking_lock_retries_eintr(false).await;
}
