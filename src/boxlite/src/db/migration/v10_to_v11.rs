//! Migration v10 → v11: Add `last_used_at` to `image_index`.
//!
//! The eviction signal for the image disk cache. Existing rows start at 0
//! (the epoch), which ranks them as the coldest entries until they are next
//! used — correct: nothing has recorded a use for them.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};

pub(crate) struct AddImageLastUsedAt;

impl Migration for AddImageLastUsedAt {
    fn source_version(&self) -> i32 {
        10
    }
    fn target_version(&self) -> i32 {
        11
    }
    fn description(&self) -> &str {
        "Add last_used_at column to image_index"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        db_err!(conn.execute_batch(
            "ALTER TABLE image_index ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;"
        ))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_adds_the_column_and_keeps_existing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE image_index (
                reference TEXT PRIMARY KEY NOT NULL,
                manifest_digest TEXT NOT NULL,
                config_digest TEXT NOT NULL,
                layers TEXT NOT NULL,
                cached_at TEXT NOT NULL,
                complete INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO image_index VALUES ('python:alpine', 'sha256:m', 'sha256:c', '[]', '2026-01-01T00:00:00Z', 1)",
            [],
        )
        .unwrap();

        AddImageLastUsedAt.run(&conn, None).unwrap();

        let (reference, last_used_at): (String, i64) = conn
            .query_row(
                "SELECT reference, last_used_at FROM image_index",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(reference, "python:alpine", "the row must survive");
        assert_eq!(
            last_used_at, 0,
            "a row from before the column existed has recorded no use yet"
        );
    }
}
