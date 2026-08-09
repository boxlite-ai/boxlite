//! Persisted per-hook fire counter, keyed by `(box_id, hook_name)`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Stores how many times each hook has fired, keyed by `(box_id, hook_name)`.
///
/// Declarative hooks persist their counts in the box state database.
/// Trait hooks reset to 1 on each re-registration.
#[derive(Clone)]
pub struct FireCountStore {
    /// (box_id, hook_name) → count
    counts: Arc<Mutex<HashMap<(String, String), u64>>>,
}

impl FireCountStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self {
            counts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Load pre-existing counts from persisted storage (e.g., box state DB).
    pub fn load(&self, box_id: &str, hook_name: &str, persisted_count: u64) {
        let mut counts = self.counts.lock().unwrap();
        counts.insert((box_id.to_string(), hook_name.to_string()), persisted_count);
    }

    /// Increment the count for a hook and return the new value.
    /// Returns 1 on first fire.
    pub fn increment_and_get(&self, box_id: &str, hook_name: &str) -> u64 {
        let mut counts = self.counts.lock().unwrap();
        let key = (box_id.to_string(), hook_name.to_string());
        let count = counts.entry(key).or_insert(0);
        *count += 1;
        *count
    }

    /// Read the current count without incrementing.
    pub fn get(&self, box_id: &str, hook_name: &str) -> u64 {
        let counts = self.counts.lock().unwrap();
        let key = (box_id.to_string(), hook_name.to_string());
        counts.get(&key).copied().unwrap_or(0)
    }

    /// Reset the count for a specific hook (used when trait hooks re-register).
    pub fn reset(&self, box_id: &str, hook_name: &str) {
        let mut counts = self.counts.lock().unwrap();
        let key = (box_id.to_string(), hook_name.to_string());
        counts.remove(&key);
    }
}

impl Default for FireCountStore {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── T-FC-01: First fire returns 1 ───────────────────────────────────

    #[test]
    fn fc_01_first_fire_returns_one() {
        let store = FireCountStore::new();
        let count = store.increment_and_get("bx1", "my-hook");
        assert_eq!(count, 1);
    }

    // ── T-FC-02: Increment across fires ─────────────────────────────────

    #[test]
    fn fc_02_increment_across_fires() {
        let store = FireCountStore::new();
        store.increment_and_get("bx1", "my-hook"); // 1
        store.increment_and_get("bx1", "my-hook"); // 2
        store.increment_and_get("bx1", "my-hook"); // 3
        let count = store.increment_and_get("bx1", "my-hook"); // 4
        assert_eq!(count, 4);
    }

    // ── T-FC-03: Persisted count can be loaded ──────────────────────────

    #[test]
    fn fc_03_load_persisted_count() {
        let store = FireCountStore::new();
        store.load("bx1", "my-hook", 2);
        // Next increment should return 3
        let count = store.increment_and_get("bx1", "my-hook");
        assert_eq!(count, 3);
    }

    // ── T-FC-04: Per-hook isolation ─────────────────────────────────────

    #[test]
    fn fc_04_per_hook_isolation() {
        let store = FireCountStore::new();
        for _ in 0..5 {
            store.increment_and_get("bx1", "hook-A");
        }
        for _ in 0..3 {
            store.increment_and_get("bx1", "hook-B");
        }
        assert_eq!(store.get("bx1", "hook-A"), 5);
        assert_eq!(store.get("bx1", "hook-B"), 3);
    }

    // ── T-FC-05: Per-box isolation ──────────────────────────────────────

    #[test]
    fn fc_05_per_box_isolation() {
        let store = FireCountStore::new();
        for _ in 0..3 {
            store.increment_and_get("box-1", "auto-snapshot");
        }
        store.increment_and_get("box-2", "auto-snapshot");

        assert_eq!(store.get("box-1", "auto-snapshot"), 3);
        assert_eq!(store.get("box-2", "auto-snapshot"), 1);
    }

    // ── T-FC-06: Trait hooks reset on re-registration ───────────────────

    #[test]
    fn fc_06_trait_hooks_reset() {
        let store = FireCountStore::new();
        store.increment_and_get("bx1", "trait-hook"); // 1
        store.increment_and_get("bx1", "trait-hook"); // 2

        // Simulate restart: re-register resets
        store.reset("bx1", "trait-hook");
        let count = store.increment_and_get("bx1", "trait-hook");
        assert_eq!(count, 1);
    }
}
