//! Lock management for per-entity multiprocess-safe locking.
//!
//! This module provides a lock manager that allocates unique locks for entities
//! (boxes, volumes, etc.). Locks are identified by a numeric ID and can be
//! retrieved by that ID across process restarts.
//!
//! Two implementations are provided:
//! - [`InMemoryLockManager`]: Single-process locks for testing
//! - [`FileLockManager`]: Cross-process locks using flock(2)

mod file;
mod memory;

#[cfg(test)]
#[path = "tests/process.rs"]
mod process_tests;

pub use file::FileLockManager;
pub use memory::InMemoryLockManager;

use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Unique identifier for a lock.
///
/// Lock IDs are assigned by the [`LockManager`] and persisted alongside
/// entity configuration. The same ID always refers to the same underlying lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct LockId(pub u32);

impl std::fmt::Display for LockId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Manager for allocating and retrieving multiprocess-safe locks.
///
/// Locks returned by a `LockManager` must be multiprocess-safe: allocating a lock
/// in process A and retrieving that lock's ID in process B must return handles
/// for the same underlying lock.
///
/// # Lock Lifecycle
///
/// 1. Call [`allocate`](LockManager::allocate) to get a new lock
/// 2. Store the [`LockId`] in persistent storage (e.g., database)
/// 3. Use [`retrieve`](LockManager::retrieve) to get the lock handle when needed
/// 4. Call [`free`](LockManager::free) when the entity is removed
///
/// # Example
///
/// ```ignore
/// let manager = FileLockManager::new("/var/run/boxlite/locks", 1024)?;
///
/// // Allocate a lock for a new box
/// let lock_id = manager.allocate()?;
/// box_config.lock_id = lock_id;
/// save_to_database(&box_config);
///
/// // Later, retrieve the lock
/// let lock = manager.retrieve(lock_id)?;
/// lock.lock();
/// // ... critical section ...
/// lock.unlock();
///
/// // When box is removed
/// manager.free(lock_id)?;
/// ```
pub trait LockManager: Send + Sync {
    /// Allocate a new lock and return its unique ID.
    ///
    /// The returned lock is guaranteed not to be returned again by `allocate`
    /// until [`free`](LockManager::free) is called on it.
    ///
    /// # Errors
    ///
    /// Returns an error if all available locks have been allocated.
    fn allocate(&self) -> BoxliteResult<LockId>;

    /// Retrieve a lock by its ID.
    ///
    /// The returned lock handle refers to the same underlying lock as any other
    /// handle retrieved with the same ID, even across different processes.
    ///
    /// # Errors
    ///
    /// Returns an error if the lock ID is invalid.
    fn retrieve(&self, id: LockId) -> BoxliteResult<Arc<dyn Locker>>;

    /// Mark a lock with the given ID as allocated and return it.
    ///
    /// This is used after a restart to reclaim locks that were previously
    /// allocated but whose allocation state was lost.
    ///
    /// # Errors
    ///
    /// Returns an error if the lock is already allocated or the ID is invalid.
    fn allocate_and_retrieve(&self, id: LockId) -> BoxliteResult<Arc<dyn Locker>>;

    /// Clear all allocated locks.
    ///
    /// This removes all lock files and clears the internal allocation state.
    /// Used during recovery to start with a clean slate before reclaiming locks.
    ///
    /// # Safety
    ///
    /// This method is only safe to call when holding the runtime lock, which
    /// ensures no other process can be using these locks.
    fn clear_all_locks(&self) -> BoxliteResult<()>;

    /// Free a lock, allowing it to be reallocated.
    ///
    /// After calling this, the lock ID may be returned by a future call
    /// to [`allocate`](LockManager::allocate).
    ///
    /// # Errors
    ///
    /// Returns an error if the lock is not currently allocated.
    fn free(&self, id: LockId) -> BoxliteResult<()>;

    /// Free all locks.
    ///
    /// # Safety
    ///
    /// This is dangerous and should only be used during testing or lock
    /// renumbering operations. If other processes hold locks, this may
    /// cause inconsistent state.
    fn free_all(&self) -> BoxliteResult<()>;

    /// Get the number of available (unallocated) locks.
    ///
    /// Returns `None` if the implementation has no maximum limit.
    fn available(&self) -> BoxliteResult<Option<u32>>;

    /// Get the number of currently allocated locks.
    fn allocated_count(&self) -> BoxliteResult<u32>;
}

/// A reader/writer lock with exclusive writes and shared reads.
///
/// All locks with the same ID refer to the same underlying lock, even across
/// different processes for multiprocess-safe implementations. Readers may
/// coexist, while a writer excludes both readers and other writers.
///
/// Retrieve a separate handle for each concurrent acquisition. A cloned `Arc`
/// shares its file descriptor and is not an independent lock owner. Nested
/// acquisition and upgrading a read lock to a write lock are unsupported.
/// Blocking and try-acquire methods are synchronous. The guards also provide
/// asynchronous acquisition with nonblocking retries; neither promises fairness.
///
/// Custom implementations may retain the default read methods, which use
/// exclusive locking. Both supplied managers implement shared reads.
pub trait Locker: Send + Sync {
    /// Get the lock's unique ID.
    fn id(&self) -> LockId;

    /// Acquire the write lock, blocking until all readers and writers release it.
    ///
    /// # Panics
    ///
    /// May panic if the lock cannot be acquired due to a fatal error.
    fn lock(&self);

    /// Release the write lock.
    ///
    /// # Panics
    ///
    /// May panic if the lock is not held or cannot be released.
    fn unlock(&self);

    /// Try to acquire the write lock without blocking.
    ///
    /// Returns `true` if the lock was acquired, `false` if it was already held.
    ///
    /// # Panics
    ///
    /// Fatal acquisition errors may panic, as with [`Self::lock`].
    fn try_lock(&self) -> bool;

    /// Acquire a read lock, blocking until the writer releases it.
    ///
    /// The default acquires an exclusive lock for compatibility with custom
    /// implementations. Fatal acquisition errors may panic, as with `lock`.
    fn read_lock(&self) {
        self.lock();
    }

    /// Release a read lock. May panic if it is not held or cannot be released.
    fn read_unlock(&self) {
        self.unlock();
    }

    /// Try to acquire a read lock without blocking.
    ///
    /// The default attempts exclusive acquisition for custom implementations.
    ///
    /// # Panics
    ///
    /// Fatal acquisition errors may panic, as with [`Self::read_lock`].
    fn try_read_lock(&self) -> bool {
        self.try_lock()
    }
}

/// RAII guard holding an exclusive write lock.
pub struct LockGuard<'a> {
    lock: &'a dyn Locker,
}

impl<'a> LockGuard<'a> {
    /// Create a new guard, acquiring the lock.
    pub fn new(lock: &'a dyn Locker) -> Self {
        lock.lock();
        Self { lock }
    }

    /// Acquire a write lock without blocking the executor thread while waiting.
    pub async fn new_async(lock: &'a dyn Locker) -> Self {
        loop {
            if let Some(guard) = Self::try_new(lock) {
                return guard;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// Try to create a new guard without blocking.
    ///
    /// Returns `None` if the lock is already held.
    pub fn try_new(lock: &'a dyn Locker) -> Option<Self> {
        if lock.try_lock() {
            Some(Self { lock })
        } else {
            None
        }
    }
}

impl Drop for LockGuard<'_> {
    fn drop(&mut self) {
        self.lock.unlock();
    }
}

/// RAII guard holding a shared read lock.
pub struct ReadLockGuard<'a> {
    lock: &'a dyn Locker,
}

impl std::fmt::Debug for ReadLockGuard<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadLockGuard")
            .field("id", &self.lock.id())
            .finish()
    }
}

impl<'a> ReadLockGuard<'a> {
    /// Acquire a read lock, blocking until it becomes available.
    pub fn new(lock: &'a dyn Locker) -> Self {
        lock.read_lock();
        Self { lock }
    }

    /// Acquire a read lock without blocking the executor thread while waiting.
    pub async fn new_async(lock: &'a dyn Locker) -> Self {
        loop {
            if let Some(guard) = Self::try_new(lock) {
                return guard;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// Try to acquire a read lock, returning `None` on contention.
    pub fn try_new(lock: &'a dyn Locker) -> Option<Self> {
        if lock.try_read_lock() {
            Some(Self { lock })
        } else {
            None
        }
    }
}

impl Drop for ReadLockGuard<'_> {
    fn drop(&mut self) {
        self.lock.read_unlock();
    }
}

// Error helpers
pub(crate) fn lock_exhausted() -> BoxliteError {
    BoxliteError::Internal("all locks have been allocated".to_string())
}

pub(crate) fn lock_not_found(id: LockId) -> BoxliteError {
    BoxliteError::NotFound(format!("lock {}", id))
}

pub(crate) fn lock_already_allocated(id: LockId) -> BoxliteError {
    BoxliteError::InvalidState(format!("lock {} is already allocated", id))
}

pub(crate) fn lock_not_allocated(id: LockId) -> BoxliteError {
    BoxliteError::InvalidState(format!("lock {} is not allocated", id))
}

pub(crate) fn lock_invalid(id: LockId, max: u32) -> BoxliteError {
    BoxliteError::InvalidArgument(format!("lock ID {} is too large (max: {})", id, max - 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    fn test_read_write_lock(manager: &dyn LockManager) {
        let id = manager.allocate().unwrap();
        let reader1 = manager.retrieve(id).unwrap();
        let reader2 = manager.retrieve(id).unwrap();
        let writer = manager.retrieve(id).unwrap();
        let other = manager.retrieve(manager.allocate().unwrap()).unwrap();

        let read1 = ReadLockGuard::new(reader1.as_ref());
        let read2 = ReadLockGuard::try_new(reader2.as_ref()).expect("readers coexist");
        assert!(LockGuard::try_new(writer.as_ref()).is_none());
        let other_write =
            LockGuard::try_new(other.as_ref()).expect("different IDs are independent");
        drop(other_write);

        drop(read1);
        assert!(!writer.try_lock(), "remaining reader must exclude writers");
        drop(read2);
        let write = LockGuard::try_new(writer.as_ref()).expect("last reader released the lock");
        assert!(ReadLockGuard::try_new(reader1.as_ref()).is_none());
        assert!(!reader2.try_lock(), "writers exclude other writers");
        drop(write);

        let read = ReadLockGuard::try_new(reader1.as_ref()).expect("writer released the lock");
        drop(read);
        assert!(writer.try_lock(), "read guard released its lock");
        writer.unlock();

        // Blocking acquisitions must hold the requested mode until their guard drops.
        for waiting_reader in [false, true] {
            let (contended_tx, contended_rx) = mpsc::channel();
            let (acquired_tx, acquired_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let held_read = (!waiting_reader).then(|| ReadLockGuard::new(reader1.as_ref()));
            let held_write = waiting_reader.then(|| LockGuard::new(writer.as_ref()));
            let waiter = manager.retrieve(id).unwrap();
            let worker = thread::spawn(move || {
                let acquired = if waiting_reader {
                    waiter.try_read_lock()
                } else {
                    waiter.try_lock()
                };
                assert!(!acquired, "waiter must encounter the held lock");
                contended_tx.send(()).unwrap();
                let hold_guard = || {
                    acquired_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                };
                if waiting_reader {
                    let _guard = ReadLockGuard::new(waiter.as_ref());
                    hold_guard();
                } else {
                    let _guard = LockGuard::new(waiter.as_ref());
                    hold_guard();
                }
            });
            contended_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(
                acquired_rx.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout),
                "waiter must not acquire before the owner releases"
            );
            drop(held_read);
            drop(held_write);
            acquired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(
                LockGuard::try_new(writer.as_ref()).is_none(),
                "blocking acquisition must exclude writers"
            );
            let concurrent_read = ReadLockGuard::try_new(reader1.as_ref());
            assert_eq!(
                concurrent_read.is_some(),
                waiting_reader,
                "blocking acquisition must hold the requested mode"
            );
            drop(concurrent_read);
            release_tx.send(()).unwrap();
            worker.join().unwrap();
        }
    }

    async fn test_async_lock_guards(manager: &dyn LockManager) {
        let id = manager.allocate().unwrap();
        let owner = manager.retrieve(id).unwrap();
        let reader = manager.retrieve(id).unwrap();
        let peer = manager.retrieve(id).unwrap();
        let writer = manager.retrieve(id).unwrap();
        let probe = manager.retrieve(id).unwrap();

        let exclusive = LockGuard::new_async(owner.as_ref()).await;
        let mut waiting_reader = Box::pin(ReadLockGuard::new_async(reader.as_ref()));
        assert!(futures::poll!(&mut waiting_reader).is_pending());
        let mut cancelled_writer = Box::pin(LockGuard::new_async(writer.as_ref()));
        assert!(futures::poll!(&mut cancelled_writer).is_pending());
        drop(cancelled_writer);
        assert!(LockGuard::try_new(probe.as_ref()).is_none());
        assert!(ReadLockGuard::try_new(probe.as_ref()).is_none());
        drop(exclusive);

        let shared = tokio::time::timeout(Duration::from_secs(1), waiting_reader)
            .await
            .expect("reader did not acquire after writer released");
        let shared_peer = tokio::time::timeout(
            Duration::from_secs(1),
            ReadLockGuard::new_async(peer.as_ref()),
        )
        .await
        .expect("second reader did not acquire while first reader held the lock");
        let mut waiting_writer = Box::pin(LockGuard::new_async(writer.as_ref()));
        assert!(futures::poll!(&mut waiting_writer).is_pending());
        drop(shared);
        assert!(LockGuard::try_new(owner.as_ref()).is_none());
        drop(shared_peer);

        let exclusive = tokio::time::timeout(Duration::from_secs(1), waiting_writer)
            .await
            .expect("writer did not acquire after last reader released");
        assert!(ReadLockGuard::try_new(reader.as_ref()).is_none());
        let mut cancelled_reader = Box::pin(ReadLockGuard::new_async(reader.as_ref()));
        assert!(futures::poll!(&mut cancelled_reader).is_pending());
        drop(cancelled_reader);
        assert!(LockGuard::try_new(probe.as_ref()).is_none());
        assert!(ReadLockGuard::try_new(probe.as_ref()).is_none());
        drop(exclusive);
        assert!(LockGuard::try_new(owner.as_ref()).is_some());
    }

    #[tokio::test]
    async fn test_in_memory_async_lock_guards() {
        test_async_lock_guards(&InMemoryLockManager::new(1)).await;
    }

    #[tokio::test]
    async fn test_file_async_lock_guards() {
        let temp = tempfile::tempdir().unwrap();
        let manager = FileLockManager::new(temp.path()).unwrap();
        test_async_lock_guards(&manager).await;
    }

    #[test]
    fn test_in_memory_read_write_lock() {
        test_read_write_lock(&InMemoryLockManager::new(4));
    }

    #[test]
    fn test_file_read_write_lock() {
        let temp = tempfile::tempdir().unwrap();
        let manager = FileLockManager::new(temp.path()).unwrap();
        test_read_write_lock(&manager);

        let id = manager.allocate().unwrap();
        let original = manager.retrieve(id).unwrap();
        let reopened = FileLockManager::open(temp.path()).unwrap();
        let reader = reopened.retrieve(id).unwrap();
        let writer = reopened.retrieve(id).unwrap();
        let read1 = ReadLockGuard::new(original.as_ref());
        let read2 = ReadLockGuard::try_new(reader.as_ref()).expect("shared reads across managers");
        drop(read1);
        assert!(!writer.try_lock(), "reopened manager still holds a reader");
        drop(read2);
        assert!(writer.try_lock());
        writer.unlock();
    }

    #[test]
    fn test_read_methods_default_to_exclusive_locking() {
        struct ExclusiveLocker(Arc<dyn Locker>);

        impl Locker for ExclusiveLocker {
            fn id(&self) -> LockId {
                self.0.id()
            }
            fn lock(&self) {
                self.0.lock();
            }
            fn unlock(&self) {
                self.0.unlock();
            }
            fn try_lock(&self) -> bool {
                self.0.try_lock()
            }
        }

        let manager = InMemoryLockManager::new(1);
        let id = manager.allocate().unwrap();
        let legacy = ExclusiveLocker(manager.retrieve(id).unwrap());
        let contender = manager.retrieve(id).unwrap();
        let read = ReadLockGuard::new(&legacy);
        assert!(
            !contender.try_read_lock(),
            "default reader remains exclusive"
        );
        drop(read);
        let write = LockGuard::new(contender.as_ref());
        assert!(ReadLockGuard::try_new(&legacy).is_none());
        drop(write);
        let read = ReadLockGuard::try_new(&legacy).expect("default try-read acquires");
        assert!(!contender.try_lock());
        drop(read);
        assert!(contender.try_lock(), "default read-unlock releases");
        contender.unlock();
    }

    fn test_lock_manager(manager: &dyn LockManager) {
        // Allocate a lock
        let id1 = manager.allocate().expect("allocate first lock");
        let id2 = manager.allocate().expect("allocate second lock");
        assert_ne!(id1, id2, "lock IDs should be unique");

        // Retrieve locks
        let lock1 = manager.retrieve(id1).expect("retrieve first lock");
        let lock2 = manager.retrieve(id2).expect("retrieve second lock");
        assert_eq!(lock1.id(), id1);
        assert_eq!(lock2.id(), id2);

        // Lock and unlock
        lock1.lock();
        lock1.unlock();

        // Try lock
        assert!(lock2.try_lock(), "try_lock should succeed");
        lock2.unlock();

        // Free locks
        manager.free(id1).expect("free first lock");
        manager.free(id2).expect("free second lock");

        // Allocate again - should get the freed IDs back
        let id3 = manager.allocate().expect("allocate after free");
        assert!(id3 == id1 || id3 == id2, "should reuse freed lock");
    }

    #[test]
    fn test_in_memory_manager() {
        let manager = InMemoryLockManager::new(16);
        test_lock_manager(&manager);
    }

    #[test]
    fn test_file_manager() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let lock_path = temp_dir.path().join("locks");
        let manager = FileLockManager::new(&lock_path).expect("create file lock manager");
        test_lock_manager(&manager);
    }

    #[test]
    fn test_lock_guard() {
        let manager = InMemoryLockManager::new(16);
        let id = manager.allocate().expect("allocate");
        let lock = manager.retrieve(id).expect("retrieve");

        {
            let _guard = LockGuard::new(lock.as_ref());
            // Lock is held here
            assert!(!lock.try_lock(), "should not be able to acquire held lock");
        }
        // Lock is released here

        assert!(lock.try_lock(), "should be able to acquire released lock");
        lock.unlock();
    }
}
