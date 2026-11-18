//! Database migration framework.
//!
//! Each migration implements the [`Migration`] trait and is registered in
//! [`all_migrations`]. Migrations run sequentially on startup when the
//! database schema version is older than the current version.

mod v10_to_v11;
mod v2_to_v3;
mod v3_to_v4;
mod v4_to_v5;
mod v5_to_v6;
mod v6_to_v7;
mod v7_to_v8;
mod v8_to_v9;
mod v9_to_v10;

use std::path::Path;

use chrono::Utc;
use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::db_err;

/// A single database migration step.
pub(crate) trait Migration {
    /// Source version this migration upgrades FROM.
    fn source_version(&self) -> i32;

    /// Target version this migration upgrades TO.
    fn target_version(&self) -> i32;

    /// Human-readable description for logging.
    fn description(&self) -> &str;

    /// Execute the migration.
    ///
    /// `home_dir` is provided for migrations that need filesystem changes
    /// (e.g., renaming box directories).
    fn run(&self, conn: &Connection, home_dir: Option<&Path>) -> BoxliteResult<()>;

    /// Whether `run` persists the target version itself.
    fn persists_version(&self) -> bool {
        false
    }
}

/// Run all applicable migrations from `source_version` to the latest version.
pub(crate) fn run_migrations(
    conn: &Connection,
    source_version: i32,
    home_dir: Option<&Path>,
) -> BoxliteResult<()> {
    let all = all_migrations();

    let mut current = source_version;
    for m in &all {
        if current == m.source_version() {
            tracing::info!(
                "Running migration {} -> {}: {}",
                m.source_version(),
                m.target_version(),
                m.description()
            );
            m.run(conn, home_dir)?;
            current = m.target_version();
            if !m.persists_version() {
                write_schema_version(conn, current)?;
            }
        }
    }

    tracing::info!("Database migration complete, now at version {current}");
    Ok(())
}

fn write_schema_version(conn: &Connection, version: i32) -> BoxliteResult<()> {
    let now = Utc::now().to_rfc3339();
    db_err!(conn.execute(
        "UPDATE schema_version SET version = ?1, updated_at = ?2 WHERE id = 1",
        rusqlite::params![version, now],
    ))?;
    Ok(())
}

/// Registry of all migrations in order.
fn all_migrations() -> Vec<Box<dyn Migration>> {
    vec![
        Box::new(v2_to_v3::AddNameColumn),
        Box::new(v3_to_v4::AddImageIndex),
        Box::new(v4_to_v5::AddSnapshots),
        Box::new(v5_to_v6::ReplaceSnapshots),
        Box::new(v6_to_v7::MoveDisksAndAddBaseDisk),
        Box::new(v7_to_v8::RenameNetworkSpec),
        Box::new(v8_to_v9::PreservePublishedPorts),
        Box::new(v9_to_v10::DropAmbiguousEmptyCapabilities),
        Box::new(v10_to_v11::RenameLegacyPaused),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, schema};

    fn schema_version(conn: &Connection) -> i32 {
        conn.query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn resumes_v2_upgrade_after_v11_version_write_failure() {
        let home = tempfile::tempdir().unwrap();
        let db_dir = home.path().join("db");
        std::fs::create_dir(&db_dir).unwrap();
        let db_path = db_dir.join("boxlite.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(schema::SCHEMA_VERSION_TABLE).unwrap();
        conn.execute_batch(
            "INSERT INTO schema_version VALUES (1, 2, 'original');
             CREATE TABLE box_config (
                 id TEXT PRIMARY KEY NOT NULL,
                 created_at INTEGER NOT NULL,
                 json TEXT NOT NULL
             );",
        )
        .unwrap();
        conn.execute_batch(schema::BOX_STATE_TABLE).unwrap();
        conn.execute_batch(
            r#"INSERT INTO box_config VALUES ('box', 0, '{"name":"legacy"}');
               INSERT INTO box_state VALUES ('box', 'paused', 4242, '{"status":"paused"}');
               CREATE TRIGGER reject_v11 BEFORE UPDATE OF version ON schema_version
               WHEN NEW.version = 11
               BEGIN SELECT RAISE(ABORT, 'injected v11 version write failure'); END;"#,
        )
        .unwrap();
        drop(conn);

        let err = Database::open(&db_path)
            .err()
            .expect("migration should hit the injected v11 version write failure");
        assert!(
            matches!(&err, BoxliteError::Database(message) if message == "injected v11 version write failure"),
            "unexpected migration error: {err}"
        );

        let conn = Connection::open(&db_path).unwrap();
        let name: String = conn
            .query_row("SELECT name FROM box_config WHERE id = 'box'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "legacy", "v2 -> v3 has already committed");
        assert_eq!(schema_version(&conn), 10, "retry must start at v10");
        conn.execute_batch("DROP TRIGGER reject_v11").unwrap();
        drop(conn);

        let db = Database::open(&db_path).expect("retry should not repeat ADD COLUMN name");
        assert_eq!(schema_version(&db.conn()), 11);
    }
}
