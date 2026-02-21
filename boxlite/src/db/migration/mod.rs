//! Database migration framework.
//!
//! Each migration implements the [`Migration`] trait and is registered in
//! [`all_migrations`]. Migrations run sequentially on startup when the
//! database schema version is older than the current version.

mod v2_to_v3;
mod v3_to_v4;
mod v4_to_v5;
mod v5_to_v6;

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
    ]
}
