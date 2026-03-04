//! Async sync points for concurrency testing.
//!
//! Adapted from RocksDB's `TEST_SYNC_POINT` for async Rust. Uses
//! `tokio::sync::Notify` + `parking_lot::Mutex` for async-safe coordination.
//!
//! Compiled to no-op in release builds via `#[cfg(debug_assertions)]`.
//!
//! # Production code usage
//!
//! ```ignore
//! // boxlite/src/vmm/shim_controller.rs
//! pub async fn stop(&self) {
//!     test_sync_point!("ShimController::stop::before_signal");
//!     self.signal_shutdown().await;
//! }
//! ```
//!
//! # Test usage
//!
//! ```ignore
//! use boxlite_test_utils::sync_point::{SyncPointRegistry, SyncPointPair};
//!
//! SyncPointRegistry::global().load_dependency(&[
//!     SyncPointPair {
//!         predecessor: "ShimController::stop::before_signal",
//!         successor: "Portal::exec::before_send",
//!     },
//! ]);
//! SyncPointRegistry::global().enable();
//! // ... spawn concurrent tasks ...
//! SyncPointRegistry::global().disable();
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use tokio::sync::Notify;

// ============================================================================
// SYNC POINT PAIR
// ============================================================================

/// A dependency relationship between two sync points.
///
/// When `predecessor` is reached, it waits until `successor` is also reached,
/// creating a happens-before relationship.
#[derive(Debug, Clone)]
pub struct SyncPointPair {
    /// The sync point that must wait.
    pub predecessor: &'static str,
    /// The sync point that unblocks the predecessor.
    pub successor: &'static str,
}

// ============================================================================
// SYNC POINT REGISTRY
// ============================================================================

/// Global registry of sync points and their dependencies.
///
/// Thread-safe via `parking_lot::Mutex`. Async-safe via `tokio::sync::Notify`.
pub struct SyncPointRegistry {
    enabled: AtomicBool,
    inner: Mutex<RegistryInner>,
}

struct RegistryInner {
    /// Map from sync point name → list of notifiers it should wait on.
    wait_on: HashMap<&'static str, Vec<std::sync::Arc<Notify>>>,
    /// Map from sync point name → list of notifiers it should trigger.
    triggers: HashMap<&'static str, Vec<std::sync::Arc<Notify>>>,
    /// Custom callbacks triggered at sync points (for advanced use).
    callbacks: HashMap<&'static str, Vec<std::sync::Arc<dyn Fn() + Send + Sync>>>,
}

static GLOBAL_REGISTRY: std::sync::OnceLock<SyncPointRegistry> = std::sync::OnceLock::new();

impl SyncPointRegistry {
    /// Get the global sync point registry.
    pub fn global() -> &'static Self {
        GLOBAL_REGISTRY.get_or_init(Self::new)
    }

    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            inner: Mutex::new(RegistryInner {
                wait_on: HashMap::new(),
                triggers: HashMap::new(),
                callbacks: HashMap::new(),
            }),
        }
    }

    /// Enable sync point processing.
    pub fn enable(&self) {
        self.enabled.store(true, Ordering::SeqCst);
    }

    /// Disable sync point processing and clear all dependencies.
    pub fn disable(&self) {
        self.enabled.store(false, Ordering::SeqCst);
        self.clear();
    }

    /// Check if sync points are enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Load dependency pairs.
    ///
    /// For each pair: when `predecessor` is reached, it waits until
    /// `successor` notifies it.
    pub fn load_dependency(&self, pairs: &[SyncPointPair]) {
        let mut inner = self.inner.lock();
        for pair in pairs {
            let notify = std::sync::Arc::new(Notify::new());

            // predecessor waits on this notify
            inner
                .wait_on
                .entry(pair.predecessor)
                .or_default()
                .push(notify.clone());

            // successor triggers this notify
            inner
                .triggers
                .entry(pair.successor)
                .or_default()
                .push(notify);
        }
    }

    /// Register a callback to fire when a sync point is reached.
    pub fn set_callback<F>(&self, name: &'static str, callback: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        let mut inner = self.inner.lock();
        inner
            .callbacks
            .entry(name)
            .or_default()
            .push(std::sync::Arc::new(callback));
    }

    /// Process a sync point hit. Called by the `test_sync_point!` macro.
    ///
    /// 1. Fire any registered callbacks
    /// 2. Notify any successors waiting on this point
    /// 3. Wait for all predecessors to complete
    pub async fn process(&self, name: &str) {
        if !self.is_enabled() {
            return;
        }

        let (callbacks, triggers, waiters) = {
            let inner = self.inner.lock();
            let callbacks: Vec<std::sync::Arc<dyn Fn() + Send + Sync>> =
                inner.callbacks.get(name).cloned().unwrap_or_default();
            let triggers: Vec<std::sync::Arc<Notify>> =
                inner.triggers.get(name).cloned().unwrap_or_default();
            let waiters: Vec<std::sync::Arc<Notify>> =
                inner.wait_on.get(name).cloned().unwrap_or_default();
            (callbacks, triggers, waiters)
        };

        // Fire callbacks
        for cb in &callbacks {
            cb();
        }

        // Notify successors
        for notify in &triggers {
            notify.notify_one();
        }

        // Wait for predecessors
        for notify in &waiters {
            notify.notified().await;
        }
    }

    /// Clear all dependencies and callbacks.
    pub fn clear(&self) {
        let mut inner = self.inner.lock();
        inner.wait_on.clear();
        inner.triggers.clear();
        inner.callbacks.clear();
    }
}

impl Default for SyncPointRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// SYNC POINT MACRO
// ============================================================================

/// Hit a sync point in production code.
///
/// In debug builds: calls `SyncPointRegistry::global().process(name).await`.
/// In release builds: compiles to nothing.
///
/// # Usage
///
/// ```ignore
/// use boxlite_test_utils::test_sync_point;
///
/// async fn stop(&self) {
///     test_sync_point!("ShimController::stop::before_signal");
///     self.signal_shutdown().await;
/// }
/// ```
#[macro_export]
macro_rules! test_sync_point {
    ($name:expr) => {
        #[cfg(debug_assertions)]
        {
            $crate::sync_point::SyncPointRegistry::global()
                .process($name)
                .await;
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_starts_disabled() {
        let reg = SyncPointRegistry::new();
        assert!(!reg.is_enabled());
    }

    #[test]
    fn enable_disable_toggle() {
        let reg = SyncPointRegistry::new();
        reg.enable();
        assert!(reg.is_enabled());
        reg.disable();
        assert!(!reg.is_enabled());
    }

    #[tokio::test]
    async fn process_noop_when_disabled() {
        let reg = SyncPointRegistry::new();
        // Should return immediately without blocking
        reg.process("nonexistent::point").await;
    }

    #[tokio::test]
    async fn callback_fires_on_process() {
        let reg = SyncPointRegistry::new();
        let fired = std::sync::Arc::new(AtomicBool::new(false));
        let fired_clone = fired.clone();

        reg.set_callback("test::callback", move || {
            fired_clone.store(true, Ordering::SeqCst);
        });

        reg.enable();
        reg.process("test::callback").await;
        assert!(fired.load(Ordering::SeqCst));
        reg.disable();
    }

    #[tokio::test]
    async fn dependency_pair_blocks_predecessor() {
        let reg = std::sync::Arc::new(SyncPointRegistry::new());

        reg.load_dependency(&[SyncPointPair {
            predecessor: "first",
            successor: "second",
        }]);
        reg.enable();

        let order = std::sync::Arc::new(Mutex::new(Vec::<&str>::new()));

        // Predecessor task — should block until successor runs
        let predecessor = tokio::spawn({
            let reg = reg.clone();
            let order = order.clone();
            async move {
                reg.process("first").await;
                order.lock().push("first_done");
            }
        });

        // Give predecessor a moment to start
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Successor task — unblocks predecessor
        order.lock().push("second_start");
        reg.process("second").await;
        order.lock().push("second_done");

        predecessor.await.unwrap();

        let final_order = order.lock().clone();
        // second_start should come before first_done (predecessor waited)
        let second_idx = final_order
            .iter()
            .position(|s| *s == "second_start")
            .unwrap();
        let first_idx = final_order.iter().position(|s| *s == "first_done").unwrap();
        assert!(
            second_idx < first_idx,
            "predecessor should wait for successor: {:?}",
            final_order
        );

        reg.disable();
    }

    #[test]
    fn clear_removes_all_state() {
        let reg = SyncPointRegistry::new();
        reg.load_dependency(&[SyncPointPair {
            predecessor: "a",
            successor: "b",
        }]);
        reg.set_callback("c", || {});

        reg.clear();

        let inner = reg.inner.lock();
        assert!(inner.wait_on.is_empty());
        assert!(inner.triggers.is_empty());
        assert!(inner.callbacks.is_empty());
    }
}
