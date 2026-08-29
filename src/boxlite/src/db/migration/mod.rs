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
        }
    }

    let now = Utc::now().to_rfc3339();
    db_err!(conn.execute(
        "UPDATE schema_version SET version = ?1, updated_at = ?2 WHERE id = 1",
        rusqlite::params![current, now],
    ))?;

    tracing::info!("Database migration complete, now at version {current}");
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
        Box::new(v10_to_v11::SplitFusedDeletionAxes),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Registration is what actually makes a migration run: each migration's
    /// own tests call `run` directly and would pass just the same if it were
    /// never added to the registry. Drive the whole chain instead, starting
    /// from the version a released build leaves behind.
    #[test]
    fn the_chain_reaches_the_current_schema_and_rescues_a_legacy_box() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (
                 id INTEGER PRIMARY KEY,
                 version INTEGER,
                 updated_at TEXT
             );
             INSERT INTO schema_version (id, version, updated_at) VALUES (1, 10, '');
             CREATE TABLE box_config (
                 id TEXT PRIMARY KEY,
                 name TEXT,
                 created_at INTEGER,
                 json TEXT NOT NULL
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO box_config (id, name, created_at, json) VALUES ('legacy', NULL, 0, ?1)",
            rusqlite::params![r#"{"options":{"auto_remove":true,"auto_delete":0}}"#],
        )
        .unwrap();

        run_migrations(&conn, 10, None).unwrap();

        let version: i32 = conn
            .query_row(
                "SELECT version FROM schema_version WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, crate::db::schema::SCHEMA_VERSION);

        let json: String = conn
            .query_row(
                "SELECT json FROM box_config WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            config.pointer("/options/auto_remove"),
            Some(&false.into()),
            "an ordinary pre-upgrade box must not come back marked remove-on-stop"
        );
    }
}
