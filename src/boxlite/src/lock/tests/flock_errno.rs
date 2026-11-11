// These fixtures cover real fatal kernel errors. The child-process signal tests
// cover blocking EINTR retries; nonblocking EINTR injection remains unverified.

use super::*;
use crate::lock::{LockGuard, ReadLockGuard};
use futures::FutureExt;
use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::Duration;

#[cfg(target_os = "macos")]
fn file_without_flock_support() -> File {
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;

    let (socket, _peer) = UnixStream::pair().unwrap();
    File::from(OwnedFd::from(socket))
}

#[cfg(target_os = "linux")]
fn file_without_flock_support() -> File {
    use std::os::unix::fs::OpenOptionsExt;

    let temp = tempfile::NamedTempFile::new().unwrap();
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH)
        .open(temp.path())
        .unwrap()
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else {
        panic!("lock panic did not preserve an error message");
    }
}

fn unsupported_lock(read: bool) -> (FileLock, String) {
    let lock = FileLock {
        id: LockId(0),
        file: file_without_flock_support(),
    };
    // The descriptor remains valid and owned; the kernel rejects flock on it.
    let reference = catch_unwind(|| {
        if read {
            lock.read_lock();
        } else {
            lock.lock();
        }
    })
    .expect_err("fixture must produce a real kernel flock error");
    let message = panic_message(reference);
    let (_, detail) = message.split_once("failed: ").unwrap();
    assert!(detail.contains("os error"), "missing errno: {message}");
    let detail = detail.to_owned();
    (lock, detail)
}

fn check_try_lock_error(read: bool) {
    let (lock, detail) = unsupported_lock(read);
    let result = catch_unwind(|| {
        if read {
            lock.try_read_lock()
        } else {
            lock.try_lock()
        }
    });
    let message = panic_message(result.expect_err("fatal flock error was returned as contention"));
    assert!(message.contains("flock("), "wrong panic: {message}");
    assert!(message.ends_with(&detail), "lost OS error: {message}");
}

async fn check_async_lock_error(read: bool) {
    let (lock, detail) = unsupported_lock(read);
    let acquire = AssertUnwindSafe(async {
        if read {
            let _guard = ReadLockGuard::new_async(&lock).await;
        } else {
            let _guard = LockGuard::new_async(&lock).await;
        }
    })
    .catch_unwind();
    let result = tokio::time::timeout(Duration::from_millis(250), acquire)
        .await
        .expect("async guard kept retrying a fatal flock error");
    let message = panic_message(result.expect_err("fatal flock error was accepted by async guard"));
    assert!(message.contains("flock("), "wrong panic: {message}");
    assert!(message.ends_with(&detail), "lost OS error: {message}");
}

#[test]
fn try_write_preserves_flock_errno() {
    check_try_lock_error(false);
}

#[test]
fn try_read_preserves_flock_errno() {
    check_try_lock_error(true);
}

#[tokio::test]
async fn async_write_preserves_flock_errno() {
    check_async_lock_error(false).await;
}

#[tokio::test]
async fn async_read_preserves_flock_errno() {
    check_async_lock_error(true).await;
}
