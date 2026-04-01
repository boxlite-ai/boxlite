//! Runtime lock mechanism to prevent concurrent BoxliteRuntime instances.
//!
//! Uses file locking (flock/fcntl) to ensure only one BoxliteRuntime can access
//! a given BOXLITE_HOME directory at a time.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// A lock guard that holds an exclusive lock on the runtime directory.
///
/// The lock is automatically released when this guard is dropped,
/// or when the process exits/crashes.
#[derive(Debug)]
pub struct RuntimeLock {
    #[allow(dead_code)] // Held for lifetime, not directly accessed
    file: File,
    path: PathBuf,
}

impl RuntimeLock {
    /// Attempt to acquire an exclusive lock on the runtime directory.
    ///
    /// # Arguments
    /// * `home_dir` - The BOXLITE_HOME directory to lock
    ///
    /// # Returns
    /// * `Ok(RuntimeLock)` - Successfully acquired lock
    /// * `Err(...)` - Another runtime is already using this directory
    ///
    /// # Example
    /// ```rust,no_run
    /// use boxlite_runtime::lock::RuntimeLock;
    /// use std::path::PathBuf;
    ///
    /// let lock = RuntimeLock::acquire(&PathBuf::from("/tmp/test"))?;
    /// // Lock is held until `lock` is dropped
    /// # Ok::<(), boxlite_runtime::errors::BoxliteError>(())
    /// ```
    pub fn acquire(home_dir: &Path) -> BoxliteResult<Self> {
        // Ensure the directory exists
        std::fs::create_dir_all(home_dir)
            .map_err(|e| BoxliteError::Storage(format!("failed to create home dir: {}", e)))?;

        let lock_path = home_dir.join(".lock");

        // Open or create the lock file
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| BoxliteError::Storage(format!("failed to open lock file: {}", e)))?;

        // Try to acquire exclusive lock (non-blocking)
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;

            let fd = file.as_raw_fd();
            let result = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };

            if result != 0 {
                let err = std::io::Error::last_os_error();
                if err.kind() == std::io::ErrorKind::WouldBlock {
                    return Err(BoxliteError::Internal(format!(
                        "Another BoxliteRuntime is already using directory: {}\n\
                         Only one runtime instance can use a BOXLITE_HOME directory at a time.",
                        home_dir.display()
                    )));
                } else {
                    return Err(BoxliteError::Storage(format!(
                        "failed to acquire lock: {}",
                        err
                    )));
                }
            }
        }

        #[cfg(not(unix))]
        {
            // Windows: Use LockFile API
            // TODO: Implement Windows file locking if needed
            compile_error!("Windows file locking not yet implemented");
        }

        tracing::debug!(lock_path = %lock_path.display(), "Acquired runtime lock");

        Ok(RuntimeLock {
            file,
            path: lock_path,
        })
    }

    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        // Lock is automatically released by OS when file is closed
        // We explicitly unlock for clarity
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let fd = self.file.as_raw_fd();
            unsafe {
                libc::flock(fd, libc::LOCK_UN);
            }
        }

        tracing::debug!(lock_path = %self.path.display(), "Released runtime lock");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use tempfile::TempDir;

    #[test]
    fn test_acquire_lock() {
        let temp_dir = TempDir::new().unwrap();
        let lock = RuntimeLock::acquire(temp_dir.path()).unwrap();

        assert!(lock.path().exists());
        assert!(lock.path().ends_with(".lock"));
    }

    #[test]
    fn test_lock_prevents_concurrent_access() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path().to_path_buf();

        // Acquire first lock
        let _lock1 = RuntimeLock::acquire(&dir_path).unwrap();

        // Try to acquire second lock (should fail)
        let result = RuntimeLock::acquire(&dir_path);
        assert!(result.is_err());

        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("Another BoxliteRuntime"));
    }

    #[test]
    fn test_lock_released_on_drop() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path().to_path_buf();

        // Acquire and immediately drop lock
        {
            let _lock = RuntimeLock::acquire(&dir_path).unwrap();
        } // Lock dropped here

        // Should be able to acquire again
        let _lock2 = RuntimeLock::acquire(&dir_path).unwrap();
    }

    #[test]
    fn test_lock_across_threads() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = Arc::new(temp_dir.path().to_path_buf());

        // Acquire lock in main thread
        let _lock1 = RuntimeLock::acquire(&dir_path).unwrap();

        // Try to acquire in another thread (should fail)
        let dir_clone = Arc::clone(&dir_path);
        let handle = thread::spawn(move || RuntimeLock::acquire(&dir_clone));

        let result = handle.join().unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn test_different_directories_independent() {
        let temp_dir1 = TempDir::new().unwrap();
        let temp_dir2 = TempDir::new().unwrap();

        // Locks on different directories should not conflict
        let _lock1 = RuntimeLock::acquire(temp_dir1.path()).unwrap();
        let _lock2 = RuntimeLock::acquire(temp_dir2.path()).unwrap();

        // Both should be held simultaneously
        assert!(_lock1.path().exists());
        assert!(_lock2.path().exists());
    }

    #[test]
    fn test_lock_file_location() {
        let temp_dir = TempDir::new().unwrap();
        let lock = RuntimeLock::acquire(temp_dir.path()).unwrap();

        assert_eq!(lock.path(), temp_dir.path().join(".lock"));
    }
}
