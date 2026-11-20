use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use rusqlite::Connection;

use super::{Migration, db_err};

pub(crate) struct PreserveRetiredProtectedAttempts;

impl Migration for PreserveRetiredProtectedAttempts {
    fn source_version(&self) -> i32 {
        10
    }

    fn target_version(&self) -> i32 {
        11
    }

    fn description(&self) -> &str {
        "Preserve protected attempt retirement evidence across Box removal"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        db_err!(conn.execute_batch(crate::db::schema::PROTECTED_BOOT_RETIREMENT_TABLE))
    }
}
