//! Box storage operations using JSON blob pattern.
//!
//! Follows Podman's design:
//! - BoxConfig: Immutable configuration (stored once at creation)
//! - BoxState: Mutable state (updated during lifecycle)
//!
//! Each table has queryable columns for filtering + JSON blob for full struct.

use chrono::Utc;
use rusqlite::{OptionalExtension, params};

use crate::litebox::config::BoxConfig;
use crate::runtime::id::BoxID;
use crate::runtime::types::BoxState;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Database, db_err};

/// Deserialize a `BoxConfig` from its JSON blob.
fn deserialize_config(json: &str) -> BoxliteResult<BoxConfig> {
    serde_json::from_str(json)
        .map_err(|e| BoxliteError::Database(format!("Failed to deserialize config: {e}")))
}

/// Deserialize a `BoxState` from its JSON blob.
fn deserialize_state(json: &str) -> BoxliteResult<BoxState> {
    serde_json::from_str(json)
        .map_err(|e| BoxliteError::Database(format!("Failed to deserialize state: {e}")))
}

/// Box storage wrapping Database.
///
/// Manages BoxConfig (immutable) and BoxState (mutable) tables.
/// Uses JSON blob pattern for flexibility with queryable columns for performance.
#[derive(Clone)]
pub struct BoxStore {
    db: Database,
}

impl BoxStore {
    /// Create a new BoxStore from a Database.
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Get a reference to the underlying database.
    #[allow(dead_code)] // Used by snapshots (temporarily disabled)
    pub(crate) fn db(&self) -> Database {
        self.db.clone()
    }

    // ========================================================================
    // BoxConfig operations (immutable after creation)
    // ========================================================================

    /// Load box configuration by ID.
    #[allow(dead_code)] // API symmetry with load_state
    pub fn load_config(&self, box_id: &str) -> BoxliteResult<Option<BoxConfig>> {
        let conn = self.db.conn();

        let json: Option<String> = db_err!(
            conn.query_row(
                "SELECT json FROM box_config WHERE id = ?1",
                params![box_id],
                |row| row.get(0),
            )
            .optional()
        )?;

        match json {
            Some(j) => Ok(Some(deserialize_config(&j)?)),
            None => Ok(None),
        }
    }

    /// Delete box configuration (and state via CASCADE).
    pub fn delete(&self, box_id: &str) -> BoxliteResult<bool> {
        let conn = self.db.conn();
        let rows_affected =
            db_err!(conn.execute("DELETE FROM box_config WHERE id = ?1", params![box_id],))?;
        Ok(rows_affected > 0)
    }

    // ========================================================================
    // BoxState operations (mutable)
    // ========================================================================

    /// Load box state by ID.
    pub fn load_state(&self, box_id: &str) -> BoxliteResult<Option<BoxState>> {
        let conn = self.db.conn();

        let json: Option<String> = db_err!(
            conn.query_row(
                "SELECT json FROM box_state WHERE id = ?1",
                params![box_id],
                |row| row.get(0),
            )
            .optional()
        )?;

        match json {
            Some(j) => Ok(Some(deserialize_state(&j)?)),
            None => Ok(None),
        }
    }

    /// Update box state.
    ///
    /// Updates both queryable columns and JSON blob.
    /// Returns error if box doesn't exist (Podman pattern: verify RowsAffected).
    pub fn update_state(&self, box_id: &str, state: &BoxState) -> BoxliteResult<()> {
        let conn = self.db.conn();

        let json = serde_json::to_string(state)
            .map_err(|e| BoxliteError::Database(format!("Failed to serialize state: {}", e)))?;

        let rows_affected = db_err!(conn.execute(
            "UPDATE box_state SET status = ?1, pid = ?2, json = ?3 WHERE id = ?4",
            params![state.status.as_str(), state.pid, json, box_id],
        ), "update_state(box={box_id})")?;

        // Podman pattern: verify rows were actually updated
        if rows_affected == 0 {
            return Err(BoxliteError::NotFound(box_id.to_string()));
        }

        Ok(())
    }

    // ========================================================================
    // Combined operations
    // ========================================================================

    /// Save both config and initial state atomically.
    ///
    /// Uses a transaction to ensure both inserts succeed or neither does.
    /// Follows Podman pattern of explicit transactions for multi-statement operations.
    pub fn save(&self, config: &BoxConfig, state: &BoxState) -> BoxliteResult<()> {
        let mut conn = self.db.conn();
        let tx = db_err!(conn.transaction(), "save(box={}): begin", config.id)?;

        // Serialize config
        let config_json = serde_json::to_string(config)
            .map_err(|e| BoxliteError::Database(format!("Failed to serialize config: {}", e)))?;

        // Serialize state
        let state_json = serde_json::to_string(state)
            .map_err(|e| BoxliteError::Database(format!("Failed to serialize state: {}", e)))?;

        // Insert config (name has UNIQUE constraint, will fail on duplicate)
        db_err!(tx.execute(
            "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, ?2, ?3, ?4)",
            params![
                config.id,
                config.name.as_deref(),
                config.created_at.timestamp(),
                config_json
            ],
        ), "save(box={}): insert config", config.id)?;

        // Insert state
        db_err!(tx.execute(
            "INSERT INTO box_state (id, status, pid, json) VALUES (?1, ?2, ?3, ?4)",
            params![config.id, state.status.as_str(), state.pid, state_json],
        ), "save(box={}): insert state", config.id)?;

        // Commit transaction
        db_err!(tx.commit(), "save(box={}): commit", config.id)?;

        Ok(())
    }

    /// Load both config and state for a box.
    ///
    /// Uses a single JOIN query instead of two separate lookups, halving
    /// lock acquisitions from 2 to 1.
    #[allow(dead_code)] // API symmetry - currently unused but part of designed API
    pub fn load(&self, box_id: &str) -> BoxliteResult<Option<(BoxConfig, BoxState)>> {
        let conn = self.db.conn();
        let result = db_err!(
            conn.query_row(
                "SELECT c.json, s.json FROM box_config c
                 JOIN box_state s ON c.id = s.id
                 WHERE c.id = ?1",
                params![box_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
        )?;
        match result {
            Some((config_json, state_json)) => Ok(Some((
                deserialize_config(&config_json)?,
                deserialize_state(&state_json)?,
            ))),
            None => Ok(None),
        }
    }

    /// Run a box query with an optional WHERE clause, returning
    /// deserialized (config, state) pairs sorted by creation time.
    fn query_boxes(&self, where_clause: &str) -> BoxliteResult<Vec<(BoxConfig, BoxState)>> {
        let conn = self.db.conn();
        let sql = format!(
            "SELECT c.json, s.json FROM box_config c
             JOIN box_state s ON c.id = s.id
             {where_clause}
             ORDER BY c.created_at DESC"
        );
        let mut stmt = db_err!(conn.prepare(&sql))?;
        let rows = db_err!(stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }))?;

        let mut result = Vec::new();
        for row in rows {
            let (config_json, state_json) = db_err!(row)?;
            result.push((deserialize_config(&config_json)?, deserialize_state(&state_json)?));
        }
        Ok(result)
    }

    /// List all boxes as (config, state) pairs.
    ///
    /// Returns boxes sorted by creation time (newest first).
    pub fn list_all(&self) -> BoxliteResult<Vec<(BoxConfig, BoxState)>> {
        self.query_boxes("")
    }

    /// List active boxes (Starting, Running, Detached).
    pub fn list_active(&self) -> BoxliteResult<Vec<(BoxConfig, BoxState)>> {
        self.query_boxes("WHERE s.status IN ('starting', 'running', 'detached')")
    }

    // ========================================================================
    // Reboot detection via alive table
    // ========================================================================

    /// Check if this is a fresh boot (alive record is stale or missing).
    ///
    /// Returns true if reboot detected (need to reset active boxes).
    pub fn check_and_update_boot(&self) -> BoxliteResult<bool> {
        let conn = self.db.conn();
        let current_boot_id = get_boot_id();

        // Check existing alive record
        let existing: Option<String> = db_err!(
            conn.query_row("SELECT boot_id FROM alive WHERE id = 1", [], |row| row
                .get(0))
                .optional()
        )?;

        let is_reboot = match existing {
            None => {
                // First run ever - not a reboot
                false
            }
            Some(stored_boot_id) => {
                // Reboot if boot ID changed
                stored_boot_id != current_boot_id
            }
        };

        // Update alive record
        let now = Utc::now().timestamp();
        db_err!(conn.execute(
            r#"
            INSERT INTO alive (id, boot_id, started_at) VALUES (1, ?1, ?2)
            ON CONFLICT(id) DO UPDATE SET boot_id = ?1, started_at = ?2
            "#,
            params![current_boot_id, now],
        ))?;

        Ok(is_reboot)
    }

    /// Reset all active boxes to stopped state after reboot.
    ///
    /// Called after reboot detection. VM rootfs is preserved, so boxes
    /// become Stopped (not Crashed) and can be restarted.
    ///
    /// All resets happen within a single transaction: either every active
    /// box is reset or none are. This avoids the N+1 lock-acquisition +
    /// autocommit pattern of the previous per-box `update_state` loop.
    pub fn reset_active_boxes_after_reboot(&self) -> BoxliteResult<Vec<BoxID>> {
        let mut conn = self.db.conn();
        let tx = db_err!(conn.transaction(), "reset_active_boxes_after_reboot: begin")?;

        // Collect active boxes within the transaction.
        let active: Vec<(String, String)> = {
            let mut stmt = db_err!(tx.prepare(
                "SELECT c.id, s.json FROM box_config c
                 JOIN box_state s ON c.id = s.id
                 WHERE s.status IN ('starting', 'running', 'detached')"
            ), "reset_active_boxes_after_reboot: select active")?;
            let rows = db_err!(stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }))?;
            db_err!(rows.collect::<Result<Vec<_>, _>>(), "reset_active_boxes_after_reboot: collect rows")?
        };

        let mut reset_ids = Vec::new();
        for (id_str, state_json) in active {
            let mut state: BoxState = deserialize_state(&state_json)?;
            state.reset_for_reboot();
            let new_json = serde_json::to_string(&state).map_err(|e| {
                BoxliteError::Database(format!(
                    "Failed to serialize state for box {id_str}: {e}"
                ))
            })?;
            db_err!(tx.execute(
                "UPDATE box_state SET status = ?1, pid = ?2, json = ?3 WHERE id = ?4",
                params![state.status.as_str(), state.pid, new_json, id_str],
            ), "reset_active_boxes_after_reboot: update box={id_str}")?;
            let id = BoxID::parse(&id_str).ok_or_else(|| {
                BoxliteError::Database(format!("Invalid box ID in database: {id_str}"))
            })?;
            reset_ids.push(id);
        }

        db_err!(tx.commit(), "reset_active_boxes_after_reboot: commit")?;

        Ok(reset_ids)
    }
}

/// Get system boot ID (unique per boot).
///
/// On macOS: Uses kern.bootsessionuuid
/// On Linux: Uses /proc/sys/kernel/random/boot_id
fn get_boot_id() -> String {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("sysctl")
            .args(["-n", "kern.bootsessionuuid"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    }

    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        uuid::Uuid::new_v4().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::litebox::config::ContainerRuntimeConfig;
    use crate::runtime::id::BoxID;
    use crate::runtime::types::{BoxStatus, ContainerID};
    use crate::vmm::VmmKind;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn create_test_db() -> (BoxStore, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        (BoxStore::new(db), dir)
    }

    fn create_test_config(id: &str) -> BoxConfig {
        use crate::runtime::options::{BoxOptions, RootfsSpec};
        let now = Utc::now();
        BoxConfig {
            id: BoxID::parse(id).unwrap(),
            name: None,
            created_at: now,
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("test:latest".to_string()),
                cpus: Some(2),
                memory_mib: Some(512),
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home: PathBuf::from("/tmp/boxes/test"),
        }
    }

    // Test IDs (26-char ULID format, accepted by BoxID::parse)
    const TEST_ID_1: &str = "01HJK4TNRPQSXYZ8WM6NCVT9R1";
    const TEST_ID_2: &str = "01HJK4TNRPQSXYZ8WM6NCVT9R2";
    const TEST_ID_3: &str = "01HJK4TNRPQSXYZ8WM6NCVT9R3";

    #[test]
    fn test_save_and_load_config() {
        let (store, _dir) = create_test_db();
        let config = create_test_config(TEST_ID_1);
        let state = BoxState::new();

        store.save(&config, &state).unwrap();

        let loaded = store.load_config(config.id.as_str()).unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().id, config.id);
    }

    #[test]
    fn test_legacy_config_rows_with_persisted_socket_paths_load() {
        // Rows written before the BoxSockets redesign persisted `transport`
        // and `ready_socket_path`. They must still deserialize (unknown
        // fields ignored) and the DERIVED socket paths must win over the
        // stale stored strings.
        let config = create_test_config(TEST_ID_1);
        let mut row = serde_json::to_value(&config).unwrap();
        row["transport"] =
            serde_json::json!({"Unix": {"socket_path": "/very/long/stale/path/box.sock"}});
        row["ready_socket_path"] = serde_json::json!("/very/long/stale/path/ready.sock");

        let loaded: BoxConfig = serde_json::from_value(row).unwrap();
        assert_eq!(loaded.id, config.id);
        // Paths derive from identity, never from the stored strings.
        assert_eq!(loaded.sockets().box_sock(), config.sockets().box_sock());
        assert!(
            !loaded
                .sockets()
                .box_sock()
                .to_string_lossy()
                .contains("stale"),
            "derived path must ignore the persisted legacy value"
        );
    }

    #[test]
    fn test_save_and_load_state() {
        let (store, _dir) = create_test_db();
        let config = create_test_config(TEST_ID_1);
        let state = BoxState::new();

        store.save(&config, &state).unwrap();

        let loaded = store.load_state(config.id.as_str()).unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().status, BoxStatus::Configured);
    }

    #[test]
    fn test_update_state() {
        let (store, _dir) = create_test_db();
        let config = create_test_config(TEST_ID_1);
        let state = BoxState::new();

        store.save(&config, &state).unwrap();

        // Update to running with PID
        let mut new_state = state.clone();
        new_state.set_status(BoxStatus::Running);
        new_state.set_pid(Some(12345));
        store.update_state(config.id.as_str(), &new_state).unwrap();

        let loaded = store.load_state(config.id.as_str()).unwrap().unwrap();
        assert_eq!(loaded.status, BoxStatus::Running);
        assert_eq!(loaded.pid, Some(12345));
    }

    #[test]
    fn test_delete() {
        let (store, _dir) = create_test_db();
        let config = create_test_config(TEST_ID_1);
        let state = BoxState::new();

        store.save(&config, &state).unwrap();
        assert!(store.load(config.id.as_str()).unwrap().is_some());

        store.delete(config.id.as_str()).unwrap();
        assert!(store.load(config.id.as_str()).unwrap().is_none());
    }

    #[test]
    fn test_list_all() {
        let (store, _dir) = create_test_db();

        // Create multiple boxes
        let ids = [TEST_ID_1, TEST_ID_2, TEST_ID_3];
        for id in ids {
            let config = create_test_config(id);
            let state = BoxState::new();
            store.save(&config, &state).unwrap();
        }

        let all = store.list_all().unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn test_list_active() {
        let (store, _dir) = create_test_db();

        // Create running box
        let config1 = create_test_config(TEST_ID_1);
        let mut state1 = BoxState::new();
        state1.set_status(BoxStatus::Running);
        store.save(&config1, &state1).unwrap();

        // Create stopped box
        let config2 = create_test_config(TEST_ID_2);
        let mut state2 = BoxState::new();
        state2.set_status(BoxStatus::Stopped);
        store.save(&config2, &state2).unwrap();

        let active = store.list_active().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].0.id.as_str(), TEST_ID_1);
    }

    #[test]
    fn test_reboot_detection() {
        let (store, _dir) = create_test_db();

        // First call - not a reboot
        let is_reboot = store.check_and_update_boot().unwrap();
        assert!(!is_reboot);

        // Second call with same boot_id - still not a reboot
        let is_reboot = store.check_and_update_boot().unwrap();
        assert!(!is_reboot);
    }

    #[test]
    fn test_reset_active_boxes_after_reboot() {
        let (store, _dir) = create_test_db();

        // Create running box
        let config = create_test_config(TEST_ID_1);
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Running);
        state.set_pid(Some(12345));
        store.save(&config, &state).unwrap();

        // Reset active boxes after reboot
        let reset_ids = store.reset_active_boxes_after_reboot().unwrap();
        assert_eq!(reset_ids.len(), 1);
        assert_eq!(reset_ids[0].as_str(), TEST_ID_1);

        // Verify state changed to Stopped (not Crashed - rootfs preserved)
        let loaded = store.load_state(config.id.as_str()).unwrap().unwrap();
        assert_eq!(loaded.status, BoxStatus::Stopped);
        assert_eq!(loaded.pid, None);
    }

    #[test]
    fn test_load_returns_both_config_and_state() {
        let (store, _dir) = create_test_db();

        let config = create_test_config(TEST_ID_1);
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Running);
        state.set_pid(Some(99999));
        store.save(&config, &state).unwrap();

        // load() should return both config and state via a single JOIN
        let result = store.load(config.id.as_str()).unwrap();
        assert!(result.is_some());
        let (loaded_config, loaded_state) = result.unwrap();
        assert_eq!(loaded_config.id, config.id);
        assert_eq!(loaded_state.status, BoxStatus::Running);
        assert_eq!(loaded_state.pid, Some(99999));
    }

    #[test]
    fn test_load_returns_none_for_nonexistent() {
        let (store, _dir) = create_test_db();
        let result = store.load("nonexistent_id").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_reset_multiple_active_boxes_atomic() {
        let (store, _dir) = create_test_db();

        // Create 3 active boxes with different statuses
        let configs: Vec<_> = [TEST_ID_1, TEST_ID_2, TEST_ID_3]
            .iter()
            .map(|id| {
                let config = create_test_config(id);
                let mut state = BoxState::new();
                state.set_status(BoxStatus::Running);
                state.set_pid(Some(1000));
                store.save(&config, &state).unwrap();
                config
            })
            .collect();

        // Also create a stopped box that should NOT be reset
        let stopped_config = create_test_config("01HJK4TNRPQSXYZ8WM6NCVT9R4");
        let mut stopped_state = BoxState::new();
        stopped_state.set_status(BoxStatus::Stopped);
        store.save(&stopped_config, &stopped_state).unwrap();

        // Reset all active boxes
        let reset_ids = store.reset_active_boxes_after_reboot().unwrap();
        assert_eq!(reset_ids.len(), 3);

        // Verify all active boxes are now Stopped with no PID
        for config in &configs {
            let state = store.load_state(config.id.as_str()).unwrap().unwrap();
            assert_eq!(state.status, BoxStatus::Stopped);
            assert_eq!(state.pid, None);
        }

        // Stopped box should be untouched
        let stopped = store.load_state(stopped_config.id.as_str()).unwrap().unwrap();
        assert_eq!(stopped.status, BoxStatus::Stopped);
    }

    #[test]
    fn test_reset_active_boxes_after_reboot_idempotent() {
        let (store, _dir) = create_test_db();

        let config = create_test_config(TEST_ID_1);
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Running);
        state.set_pid(Some(12345));
        store.save(&config, &state).unwrap();

        // First reset
        let reset_ids = store.reset_active_boxes_after_reboot().unwrap();
        assert_eq!(reset_ids.len(), 1);

        // Second reset — no active boxes left
        let reset_ids = store.reset_active_boxes_after_reboot().unwrap();
        assert_eq!(reset_ids.len(), 0);
    }
}
