//! Database migration framework.
//!
//! Each migration implements the [`Migration`] trait and is registered in
//! [`all_migrations`]. Migrations run sequentially on startup when the
//! database schema version is older than the current version.

mod v2_to_v3;
mod v3_to_v4;
mod v4_to_v5;
mod v5_to_v6;
mod v6_to_v7;
mod v7_to_v8;
mod v8_to_v9;

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
///
/// All migrations and the final `schema_version` update are wrapped in a
/// single transaction. If any migration fails, the entire batch rolls back
/// so the database is left at `source_version` — the next startup will retry
/// from the same point.
///
/// **Note**: migrations that perform filesystem operations (e.g. v6→v7 moves
/// disk files) cannot be rolled back by the transaction. Those migrations are
/// still responsible for their own filesystem-level idempotency.
pub(crate) fn run_migrations(
    conn: &Connection,
    source_version: i32,
    home_dir: Option<&Path>,
) -> BoxliteResult<()> {
    let all = all_migrations();

    let tx = db_err!(conn.unchecked_transaction(), "run_migrations(v{source_version}): begin")?;

    let mut current = source_version;
    for m in &all {
        if current == m.source_version() {
            tracing::info!(
                "Running migration {} -> {}: {}",
                m.source_version(),
                m.target_version(),
                m.description()
            );
            m.run(&tx, home_dir)?;
            current = m.target_version();
        }
    }

    let now = Utc::now().to_rfc3339();
    db_err!(tx.execute(
        "UPDATE schema_version SET version = ?1, updated_at = ?2 WHERE id = 1",
        rusqlite::params![current, now],
    ), "run_migrations: update schema_version to v{current}")?;

    db_err!(tx.commit(), "run_migrations(v{source_version} -> v{current}): commit")?;

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
    ]
}
