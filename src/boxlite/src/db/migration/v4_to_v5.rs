//! Migration v4 → v5: Add legacy snapshots table.

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};

pub(crate) struct AddSnapshots;

impl Migration for AddSnapshots {
    fn source_version(&self) -> i32 {
        4
    }
    fn target_version(&self) -> i32 {
        5
    }
    fn description(&self) -> &str {
        "Add snapshots table (legacy)"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&std::path::Path>) -> BoxliteResult<()> {
        db_err!(conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY NOT NULL,
                box_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY (box_id) REFERENCES box_config(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_box_id ON snapshots(box_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_box_name ON snapshots(box_id, name);
            "#
        ))?;
        Ok(())
    }
}
