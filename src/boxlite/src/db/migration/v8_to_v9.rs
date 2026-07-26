//! Migration v8 → v9: establish the capability-policy compatibility boundary.
//!
//! `BoxOptions` is stored as JSON, so no row rewrite is needed. Bumping the
//! schema prevents a v8 binary—which does not understand
//! `advanced.capabilities`—from opening a database after a newer binary may
//! have persisted that policy and silently restoring a weaker policy.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::BoxliteResult;

use super::Migration;

pub(crate) struct GuardCapabilityPolicy;

impl Migration for GuardCapabilityPolicy {
    fn source_version(&self) -> i32 {
        8
    }

    fn target_version(&self) -> i32 {
        9
    }

    fn description(&self) -> &str {
        "Require capability-aware readers for persisted BoxOptions"
    }

    fn run(&self, _conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        Ok(())
    }
}
