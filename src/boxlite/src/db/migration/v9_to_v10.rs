//! Migration v9 → v10: Add a content digest column to `base_disk`.
//!
//! Layers are addressed by content when they travel between hosts, so a base
//! needs a digest that can be looked up without scanning every JSON blob. The
//! column is nullable and left empty here: a base is immutable, so its digest
//! is computed once, on first use, rather than by hashing every existing layer
//! during startup.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};

pub(crate) struct AddBaseDiskDigest;

impl Migration for AddBaseDiskDigest {
    fn source_version(&self) -> i32 {
        9
    }
    fn target_version(&self) -> i32 {
        10
    }
    fn description(&self) -> &str {
        "Add base_disk.digest column and index"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        db_err!(conn.execute("ALTER TABLE base_disk ADD COLUMN digest TEXT", []))?;
        db_err!(conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_base_disk_digest ON base_disk(digest)",
            [],
        ))?;

        tracing::info!("Added base_disk.digest column (populated lazily on first use)");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v9_base_disk_table(conn: &Connection) {
        conn.execute_batch(
            r#"CREATE TABLE base_disk (
                id TEXT PRIMARY KEY NOT NULL,
                source_box_id TEXT NOT NULL,
                name TEXT,
                kind TEXT NOT NULL,
                base_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                json TEXT NOT NULL
            );"#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO base_disk (id, source_box_id, name, kind, base_path, created_at, json) \
             VALUES ('abc', 'box1', NULL, 'clone_base', '/bases/abc.qcow2', 1, '{}')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn existing_rows_survive_with_a_null_digest() {
        let conn = Connection::open_in_memory().unwrap();
        v9_base_disk_table(&conn);

        AddBaseDiskDigest.run(&conn, None).unwrap();

        // A pre-existing layer keeps a NULL digest, so the lazy computation
        // path — not the migration — is what fills it in. Hashing every base
        // here would read every cached layer on the first startup after an
        // upgrade.
        let digest: Option<String> = conn
            .query_row("SELECT digest FROM base_disk WHERE id = 'abc'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(digest, None);
    }

    #[test]
    fn digest_column_is_writable_after_migration() {
        let conn = Connection::open_in_memory().unwrap();
        v9_base_disk_table(&conn);

        AddBaseDiskDigest.run(&conn, None).unwrap();
        conn.execute(
            "UPDATE base_disk SET digest = 'sha256:dead' WHERE id = 'abc'",
            [],
        )
        .unwrap();

        let digest: Option<String> = conn
            .query_row("SELECT digest FROM base_disk WHERE id = 'abc'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(digest.as_deref(), Some("sha256:dead"));
    }
}
