//! Migration v10 → v11: distinguish legacy disk quiescence from checkpoint pause.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err, write_schema_version};

pub(crate) struct RenameLegacyPaused;

impl Migration for RenameLegacyPaused {
    fn source_version(&self) -> i32 {
        10
    }

    fn target_version(&self) -> i32 {
        11
    }

    fn description(&self) -> &str {
        "Rename legacy paused box states to quiesced"
    }

    fn persists_version(&self) -> bool {
        true
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        let transaction = db_err!(conn.unchecked_transaction())?;
        // Change each representation only when it contains the legacy value.
        // One statement keeps the queryable column and JSON atomic, preserving
        // all other columns and JSON fields (including future/unknown fields).
        db_err!(transaction.execute(
            "UPDATE box_state SET
                status = CASE WHEN status = 'paused' THEN 'quiesced' ELSE status END,
                json = CASE WHEN json_extract(json, '$.status') = 'paused'
                    THEN json_set(json, '$.status', 'quiesced') ELSE json END
             WHERE status = 'paused' OR json_extract(json, '$.status') = 'paused'",
            [],
        ))?;
        write_schema_version(&transaction, self.target_version())?;
        db_err!(transaction.commit())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, schema};

    fn open_with_box_state() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE box_state (
                id TEXT PRIMARY KEY, status TEXT NOT NULL, pid INTEGER, json TEXT NOT NULL
            )",
        )
        .unwrap();
        conn.execute_batch(schema::SCHEMA_VERSION_TABLE).unwrap();
        conn.execute(
            "INSERT INTO schema_version (id, version, updated_at) VALUES (1, 10, 'original')",
            [],
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, status: &str, json: &str) {
        conn.execute(
            "INSERT INTO box_state (id, status, pid, json) VALUES (?1, ?2, 4242, ?3)",
            rusqlite::params![id, status, json],
        )
        .unwrap();
    }

    fn load(conn: &Connection, id: &str) -> (String, u32, String) {
        conn.query_row(
            "SELECT status, pid, json FROM box_state WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    #[test]
    fn rewrites_both_statuses_and_preserves_other_fields() {
        let conn = open_with_box_state();
        let original = serde_json::json!({
            "status": "paused", "pid": 4242, "last_updated": "unchanged",
            "future_field": {"nested": [1, "paused", true]}, "lock_id": 7
        });
        insert(&conn, "frozen", "paused", &original.to_string());
        conn.execute_batch(
            "CREATE TRIGGER reject_extra_version_write BEFORE UPDATE OF version ON schema_version
             WHEN OLD.version != 10 OR NEW.version != 11
             BEGIN SELECT RAISE(ABORT, 'expected a single version bump from 10 to 11'); END;",
        )
        .unwrap();

        super::super::run_migrations(&conn, 10, None).unwrap();

        let (status, pid, json) = load(&conn, "frozen");
        assert_eq!(status, "quiesced");
        assert_eq!(pid, 4242);
        let mut expected = original;
        expected["status"] = "quiesced".into();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap(),
            expected
        );
        let version: i32 = conn
            .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 11);
    }

    #[test]
    fn leaves_other_states_byte_for_byte_unchanged() {
        let conn = open_with_box_state();
        for status in [
            "unknown",
            "configured",
            "running",
            "stopping",
            "stopped",
            "failed",
            "quiesced",
        ] {
            let json = format!(r#"{{ "status": "{status}", "unrelated": "paused" }}"#);
            insert(&conn, status, status, &json);
            RenameLegacyPaused.run(&conn, None).unwrap();
            assert_eq!(load(&conn, status), (status.to_string(), 4242, json));
        }
    }

    #[test]
    fn repeated_run_does_not_rewrite_rows() {
        let conn = open_with_box_state();
        insert(&conn, "frozen", "paused", r#"{"status":"paused"}"#);
        RenameLegacyPaused.run(&conn, None).unwrap();
        let after = load(&conn, "frozen");
        conn.execute_batch(
            "CREATE TRIGGER reject_rewrite BEFORE UPDATE ON box_state
             BEGIN SELECT RAISE(ABORT, 'unexpected rewrite'); END;",
        )
        .unwrap();
        RenameLegacyPaused.run(&conn, None).unwrap();
        assert_eq!(load(&conn, "frozen"), after);
    }

    #[test]
    fn version_11_does_not_migrate_new_checkpoint_paused_rows() {
        let conn = open_with_box_state();
        conn.execute("UPDATE schema_version SET version = 11", [])
            .unwrap();
        let json = r#"{ "status": "paused", "new_checkpoint": true }"#;
        insert(&conn, "checkpoint", "paused", json);

        Database::init_schema(&conn, Path::new("/unused/db/boxlite.db")).unwrap();

        assert_eq!(
            load(&conn, "checkpoint"),
            ("paused".to_string(), 4242, json.to_string())
        );
        let updated: String = conn
            .query_row("SELECT updated_at FROM schema_version", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(updated, "original");
    }

    #[test]
    fn failed_version_write_rolls_back_status_rewrite() {
        let conn = open_with_box_state();
        let json = r#"{ "status": "paused", "extra": true }"#;
        let ids = ["frozen-1", "frozen-2"];
        for id in ids {
            insert(&conn, id, "paused", json);
        }
        conn.execute_batch(
            "CREATE TRIGGER reject_version_write BEFORE UPDATE OF version ON schema_version
             WHEN OLD.version = 10 AND NEW.version = 11 AND (
                 SELECT COUNT(*) FROM box_state
                 WHERE status = 'quiesced' AND json_extract(json, '$.status') = 'quiesced'
             ) = 2
             BEGIN SELECT RAISE(ABORT, 'injected version write failure'); END;",
        )
        .unwrap();

        let err = super::super::run_migrations(&conn, 10, None).unwrap_err();
        assert!(
            matches!(&err, BoxliteError::Database(message) if message == "injected version write failure"),
            "unexpected migration error: {err}"
        );
        let version: i32 = conn
            .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 10);
        assert_eq!(
            ids.map(|id| load(&conn, id)),
            ids.map(|_| ("paused".to_string(), 4242, json.to_string())),
            "both rows must retain their original paused column and JSON after rollback"
        );
        assert!(conn.is_autocommit());
    }

    #[test]
    fn failed_update_rolls_back_both_representations() {
        let conn = open_with_box_state();
        let json = r#"{"status":"paused"}"#;
        insert(&conn, "frozen", "paused", json);
        conn.execute_batch(
            "CREATE TRIGGER reject_update AFTER UPDATE ON box_state
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
        )
        .unwrap();
        assert!(RenameLegacyPaused.run(&conn, None).is_err());
        assert_eq!(
            load(&conn, "frozen"),
            ("paused".to_string(), 4242, json.to_string())
        );
        assert!(conn.is_autocommit());
    }
}
