//! Runtime-level metrics (aggregate across all boxes).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Storage for runtime-wide metrics.
///
/// Stored in `RuntimeState`, shared across all operations.
/// All counters are monotonic (never decrease).
#[derive(Clone, Default)]
pub struct RuntimeMetricsStorage {
    /// Total boxes created since runtime startup
    pub(crate) boxes_created: Arc<AtomicU64>,
    /// Total boxes that failed to start
    pub(crate) boxes_failed: Arc<AtomicU64>,
    /// Total boxes stopped (explicitly or via shutdown)
    pub(crate) boxes_stopped: Arc<AtomicU64>,
    /// Total commands executed across all boxes
    pub(crate) total_commands: Arc<AtomicU64>,
    /// Total command execution errors across all boxes
    pub(crate) total_exec_errors: Arc<AtomicU64>,
}

impl RuntimeMetricsStorage {
    /// Create new runtime metrics storage.
    pub fn new() -> Self {
        Self::default()
    }
}

/// Handle for querying runtime-wide metrics.
///
/// Cloneable, lightweight handle (only Arc pointers).
/// All counters are monotonic and never reset.
#[derive(Clone)]
pub struct RuntimeMetrics {
    storage: RuntimeMetricsStorage,
}

impl RuntimeMetrics {
    /// Create new handle from storage.
    pub(crate) fn new(storage: RuntimeMetricsStorage) -> Self {
        Self { storage }
    }

    /// Total number of boxes created since runtime startup.
    ///
    /// Incremented when `BoxliteRuntime::create()` is called.
    /// Never decreases (monotonic counter).
    pub fn boxes_created_total(&self) -> u64 {
        self.storage.boxes_created.load(Ordering::Relaxed)
    }

    /// Total number of boxes that failed to start.
    ///
    /// Incremented when box creation or initialization fails.
    /// Never decreases (monotonic counter).
    pub fn boxes_failed_total(&self) -> u64 {
        self.storage.boxes_failed.load(Ordering::Relaxed)
    }

    /// Total number of boxes that have been stopped.
    ///
    /// Incremented when `LiteBox::stop()` completes successfully.
    /// Never decreases (monotonic counter).
    pub fn boxes_stopped_total(&self) -> u64 {
        self.storage.boxes_stopped.load(Ordering::Relaxed)
    }

    /// Number of currently running boxes.
    ///
    /// Calculated as: boxes_created - boxes_stopped - boxes_failed
    pub fn num_running_boxes(&self) -> u64 {
        let created = self.boxes_created_total();
        let stopped = self.boxes_stopped_total();
        let failed = self.boxes_failed_total();
        created.saturating_sub(stopped).saturating_sub(failed)
    }

    /// Total commands executed across all boxes.
    ///
    /// Incremented on every `LiteBox::exec()` call.
    /// Never decreases (monotonic counter).
    pub fn total_commands_executed(&self) -> u64 {
        self.storage.total_commands.load(Ordering::Relaxed)
    }

    /// Total command execution errors across all boxes.
    ///
    /// Incremented when `LiteBox::exec()` returns error.
    /// Never decreases (monotonic counter).
    pub fn total_exec_errors(&self) -> u64 {
        self.storage.total_exec_errors.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_num_running_boxes_calculation() {
        let storage = RuntimeMetricsStorage::new();
        let metrics = RuntimeMetrics::new(storage.clone());

        // Initially all counters are 0
        assert_eq!(metrics.num_running_boxes(), 0);

        // Create 5 boxes
        for _ in 0..5 {
            storage.boxes_created.fetch_add(1, Ordering::Relaxed);
        }
        assert_eq!(metrics.num_running_boxes(), 5);

        // Stop 2 boxes
        storage.boxes_stopped.fetch_add(1, Ordering::Relaxed);
        storage.boxes_stopped.fetch_add(1, Ordering::Relaxed);
        assert_eq!(metrics.num_running_boxes(), 3);

        // 1 box fails to start
        storage.boxes_created.fetch_add(1, Ordering::Relaxed);
        storage.boxes_failed.fetch_add(1, Ordering::Relaxed);
        assert_eq!(metrics.num_running_boxes(), 3);

        // Stop remaining boxes
        for _ in 0..3 {
            storage.boxes_stopped.fetch_add(1, Ordering::Relaxed);
        }
        assert_eq!(metrics.num_running_boxes(), 0);
    }

    #[test]
    fn test_num_running_boxes_saturating_sub() {
        let storage = RuntimeMetricsStorage::new();
        let metrics = RuntimeMetrics::new(storage.clone());

        // Edge case: more stopped than created (shouldn't happen, but test safety)
        storage.boxes_created.fetch_add(1, Ordering::Relaxed);
        storage.boxes_stopped.fetch_add(5, Ordering::Relaxed);

        // Should saturate to 0, not underflow
        assert_eq!(metrics.num_running_boxes(), 0);
    }

    #[test]
    fn test_boxes_stopped_total() {
        let storage = RuntimeMetricsStorage::new();
        let metrics = RuntimeMetrics::new(storage.clone());

        assert_eq!(metrics.boxes_stopped_total(), 0);

        storage.boxes_stopped.fetch_add(3, Ordering::Relaxed);
        assert_eq!(metrics.boxes_stopped_total(), 3);
    }
}
