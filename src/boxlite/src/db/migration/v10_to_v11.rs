//! Migration v10 → v11: shared ext4 image tables. No backfill.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};
use crate::db::schema;

pub(crate) struct AddSharedExt4;

impl Migration for AddSharedExt4 {
    fn source_version(&self) -> i32 {
        10
    }

    fn target_version(&self) -> i32 {
        11
    }

    fn description(&self) -> &str {
        "Add shared ext4 image and image_disk tables"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        db_err!(conn.execute_batch(schema::IMAGE_TABLE))?;
        db_err!(conn.execute_batch(schema::IMAGE_DISK_TABLE))?;
        db_err!(conn.execute_batch(schema::DISK_TABLE))?;
        Ok(())
    }
}
