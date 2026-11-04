use super::Migration;
use crate::db::{db_err, schema};
use crate::{BoxliteError, BoxliteResult};
use rusqlite::Connection;
use std::path::Path;

pub(crate) struct AddCheckpoints;
impl Migration for AddCheckpoints {
    fn source_version(&self) -> i32 {
        10
    }
    fn target_version(&self) -> i32 {
        11
    }
    fn description(&self) -> &str {
        "Add source-independent memory checkpoint catalog"
    }
    fn run(&self, conn: &Connection, _home: Option<&Path>) -> BoxliteResult<()> {
        db_err!(conn.execute_batch(schema::CHECKPOINT_TABLE))
    }
}
