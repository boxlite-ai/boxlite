//! Fault injection framework for testing error paths.
//!
//! `FaultInjector` uses atomic flags for thread-safe control of simulated failures.
//! Requires `#[cfg(feature = "fault-injection")]` hooks in production code.
//!
//! # Example
//!
//! ```ignore
//! use boxlite_test_utils::fault_injection::FaultInjector;
//!
//! let injector = FaultInjector::new();
//! injector.enable_portal_failure();
//! // ... test that gRPC calls fail gracefully ...
//! injector.reset();
//! ```

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

/// Thread-safe fault injection controller.
///
/// Uses atomic operations for lock-free, thread-safe flag checking.
/// Production code checks these flags at injection points.
pub struct FaultInjector {
    /// Fail all portal (gRPC) calls.
    portal_failure: AtomicBool,
    /// Fail portal calls after N successful ones.
    portal_fail_after: AtomicU32,
    /// Counter for successful portal calls (compared against `portal_fail_after`).
    portal_call_count: AtomicU32,
    /// Simulate disk full errors.
    disk_full: AtomicBool,
    /// Artificial portal latency in milliseconds (0 = none).
    portal_latency_ms: AtomicU64,
}

static GLOBAL_INJECTOR: std::sync::OnceLock<FaultInjector> = std::sync::OnceLock::new();

impl FaultInjector {
    /// Create a new fault injector with all faults disabled.
    pub fn new() -> Self {
        Self {
            portal_failure: AtomicBool::new(false),
            portal_fail_after: AtomicU32::new(u32::MAX),
            portal_call_count: AtomicU32::new(0),
            disk_full: AtomicBool::new(false),
            portal_latency_ms: AtomicU64::new(0),
        }
    }

    /// Get the global fault injector.
    pub fn global() -> &'static Self {
        GLOBAL_INJECTOR.get_or_init(Self::new)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Portal (gRPC) faults
    // ────────────────────────────────────────────────────────────────────────

    /// Enable unconditional portal failure.
    pub fn enable_portal_failure(&self) {
        self.portal_failure.store(true, Ordering::SeqCst);
    }

    /// Disable portal failure.
    pub fn disable_portal_failure(&self) {
        self.portal_failure.store(false, Ordering::SeqCst);
    }

    /// Fail portal calls after `n` successful ones.
    pub fn fail_portal_after(&self, n: u32) {
        self.portal_call_count.store(0, Ordering::SeqCst);
        self.portal_fail_after.store(n, Ordering::SeqCst);
    }

    /// Check if a portal call should fail.
    ///
    /// Called at injection points in production code.
    /// Returns `true` if the call should be failed.
    pub fn should_fail_portal(&self) -> bool {
        if self.portal_failure.load(Ordering::SeqCst) {
            return true;
        }

        let count = self.portal_call_count.fetch_add(1, Ordering::SeqCst);
        let threshold = self.portal_fail_after.load(Ordering::SeqCst);
        count >= threshold
    }

    /// Set artificial portal latency in milliseconds.
    pub fn set_portal_latency(&self, ms: u64) {
        self.portal_latency_ms.store(ms, Ordering::SeqCst);
    }

    /// Get current portal latency setting.
    pub fn portal_latency(&self) -> u64 {
        self.portal_latency_ms.load(Ordering::SeqCst)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Disk faults
    // ────────────────────────────────────────────────────────────────────────

    /// Enable disk full simulation.
    pub fn enable_disk_full(&self) {
        self.disk_full.store(true, Ordering::SeqCst);
    }

    /// Disable disk full simulation.
    pub fn disable_disk_full(&self) {
        self.disk_full.store(false, Ordering::SeqCst);
    }

    /// Check if disk operations should fail with "disk full".
    pub fn should_fail_disk(&self) -> bool {
        self.disk_full.load(Ordering::SeqCst)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Reset
    // ────────────────────────────────────────────────────────────────────────

    /// Reset all fault injection state to defaults.
    pub fn reset(&self) {
        self.portal_failure.store(false, Ordering::SeqCst);
        self.portal_fail_after.store(u32::MAX, Ordering::SeqCst);
        self.portal_call_count.store(0, Ordering::SeqCst);
        self.disk_full.store(false, Ordering::SeqCst);
        self.portal_latency_ms.store(0, Ordering::SeqCst);
    }
}

impl Default for FaultInjector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_with_no_faults() {
        let fi = FaultInjector::new();
        assert!(!fi.should_fail_portal());
        assert!(!fi.should_fail_disk());
        assert_eq!(fi.portal_latency(), 0);
    }

    #[test]
    fn portal_failure_toggle() {
        let fi = FaultInjector::new();
        fi.enable_portal_failure();
        assert!(fi.should_fail_portal());
        fi.disable_portal_failure();
        // Reset counter since should_fail_portal increments it
        fi.reset();
        assert!(!fi.should_fail_portal());
    }

    #[test]
    fn fail_portal_after_n() {
        let fi = FaultInjector::new();
        fi.fail_portal_after(3);

        // First 3 calls succeed
        assert!(!fi.should_fail_portal()); // count 0 < 3
        assert!(!fi.should_fail_portal()); // count 1 < 3
        assert!(!fi.should_fail_portal()); // count 2 < 3

        // 4th call fails
        assert!(fi.should_fail_portal()); // count 3 >= 3
        assert!(fi.should_fail_portal()); // count 4 >= 3
    }

    #[test]
    fn disk_full_toggle() {
        let fi = FaultInjector::new();
        fi.enable_disk_full();
        assert!(fi.should_fail_disk());
        fi.disable_disk_full();
        assert!(!fi.should_fail_disk());
    }

    #[test]
    fn portal_latency() {
        let fi = FaultInjector::new();
        fi.set_portal_latency(100);
        assert_eq!(fi.portal_latency(), 100);
        fi.set_portal_latency(0);
        assert_eq!(fi.portal_latency(), 0);
    }

    #[test]
    fn reset_clears_all() {
        let fi = FaultInjector::new();
        fi.enable_portal_failure();
        fi.enable_disk_full();
        fi.set_portal_latency(500);
        fi.fail_portal_after(5);

        fi.reset();

        assert!(!fi.should_fail_portal());
        assert!(!fi.should_fail_disk());
        assert_eq!(fi.portal_latency(), 0);
    }
}
